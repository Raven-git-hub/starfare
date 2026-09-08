# Venture teardown — `decommissionVenture` (design, ready to build)

*Status: **design captured 07-09-26** from the venture-management / teardown design pass. This is the
**authoritative** source for how a guild closes a venture it owns. It is the teardown half of the venture
lifecycle whose other half is `docs/venture-establishment.md`; it is also the first concrete piece of the
"venture management" hole (§2.7, undesigned until now). The **licensed-deuterium-mine** case and its hardening
are **DEFERRED to a later slice** — see §6; everything else here is ready to build.*

*It **invents no tuning number.** Every figure teardown uses is already ruled: the settlement fee is built from
the licence's stored `discountedFee` and `windowDays`, the lockout from `windowDays × windowN`, the reputation
forfeit from the venture's own `reputation`. There is no `[FIRST-CUT]` in this design, and there is no new
constant for `phase-1-tuning.md`.*

## 0. The one-line frame

A guild may **close a venture it owns**. Closing removes the venture; the site it sat on goes vacant and the
asset it ran goes idle, both **for free, because both are derived** (`sim/occupancy.js`, `sim/assets.js`) — the
same fact the establish apply flagged as missing: *"Deploy is one-way in this slice — nothing returns an asset
to idle until cancel-licence exists (§4)."* Teardown is that mechanism.

What teardown **costs** depends on what the venture was:

- **Unlicensed** venture (ordinary mine/factory, an **unlicensed** deuterium mine, or an **illegal deuterium
  refinery**) → trivially clean: remove it, free its site and asset. No fee, no lockout. Reputation forfeit is
  whatever RP it had, which for these is ~0.
- **Ordinary-licensed** venture (`venture.licence` present) → a **settlement**: forfeit the venture's RP
  (automatic), pay the **remaining contract fee**, and the **node is locked to the owner** until the contract
  term ends.
- **Licensed deuterium mine** (`venture.deuteriumLicence` present) → **DEFERRED** (§6): refused this slice.

## 1. The action — `decommissionVenture { guildId, ventureId }`

The action shape is exactly `{ guildId, ventureId }` and nothing more — the settlement is **computed by the
engine**, never passed in, the same discipline the licence fee follows (`sim/licence.js`). Validate, in intake
order (`sim/actions.js`, `validateAction`): the guild exists; the venture exists **and belongs to this guild**
(scan only this guild's ventures — closing is an act on a venture you own); and — this slice — the venture is
**not** a licensed deuterium mine (§6). Apply (`applyAction`, on the `structuredClone`d `next`), in this order:

1. **Charge the settlement fee** (ordinary-licensed only) — §3.2.
2. **Forfeit the RP and remove the venture** — §3.1.
3. **Free the site and asset** — nothing to do; both are derived (§0).
4. **Write the node lockout** (ordinary-licensed with contract time left) — §3.3.

No `galacticSupply` refresh is needed: teardown moves no stockpile and no fuel. The only credit movement is the
settlement fee, which — like `paySyndicateFee` — touches no supply cache.

## 2. The automatic consequence — the mean line does the punishing

This is the load-bearing insight, and it means teardown needs **almost no punishment code of its own.** Removing
a venture drops **both** halves of the mean line at once:

- its **RP** leaves the guild sum (`guild.guildReputation -= venture.reputation`, §3.1), and
- its **GP** leaves, because GP is **derived** (`sim/points.js`, recomputed each snapshot) — the venture is gone,
  so its tier weight is gone.

The fuel issuance modifier is `1 + ISSUANCE_SENSITIVITY × (RP − GP)/GP` (`docs/points-and-reputation.md` §3), so
removing a venture moves the gap by `(GP_v − RP_v)` — its GP weight minus its earned RP. Therefore:

- Tear down a **mature, profitable** venture (high RP, `RP_v ≫ GP_v`) → the gap falls, the modifier falls, the
  guild's fuel falls. A real, sustained, guild-wide cost.
- Tear down a **dud** (low or negative RP, `RP_v < GP_v`) → the gap rises, the modifier rises. Closing it is not
  just cheap, it is beneficial.

That is exactly the design goal — *punish closing the profitable, make it simple to close the unprofitable* —
achieved by the existing mean line with no special teardown rule. The reputation "forfeit" is **not a flat
penalty**; it is the venture's own earned standing leaving the sum, which the mean line converts into a fuel
swing scaled by how much the venture had earned. It also closes the signing-bump exploit for free: the bump
lives on `venture.reputation`, so tearing a venture down surrenders the bump with it — it can never be farmed by
sign-then-close.

## 3. The settlement — three layers, three distinct jobs

### 3.1 RP forfeit — automatic (invariant 8)

The **only** reputation bookkeeping teardown does: when it removes venture `v`, `guild.guildReputation -=
(v.reputation || 0)`, in the same mutation that splices `v` out of `guild.ventures`. The founding endowment is
untouched, the venture leaves the array, so `checkGuildReputationSum` (`guildReputation == Σ venture.reputation +
foundingEndowment`) stays exact. This mirrors the one existing RP-move shape (`sim/tick.js`, `applyForLicence`):
the guild total and the row it totals move by the same amount, in the same place.

### 3.2 The contract-obligation fee — the one thing RP does not cover

The mean line punishes losing *earned standing*. It says nothing about the *promise* a licensed venture made —
output for the contract term. That is what the fee charges, and only a licensed venture owes it:

    remainingCycles = max(0, licence.windowDays − floor((state.tick − licence.signedTick) / windowN))
    settlementFee   = remainingCycles × licence.discountedFee

where `windowN = state.windowN ?? DEFAULT_WINDOW_N` (a cycle = a day = `windowN` ticks, `sim/windows.js`). The
fee is the **negotiated (discounted) rate**, not the basic fee — the player pays out the deal they signed. The
**current partial cycle counts as a whole one** (the `floor` on elapsed cycles), a deliberate first-cut that
slightly favours the Syndicate and keeps the arithmetic a plain integer product — no rounding.

**Past the contract term this is 0 — teardown is free in the rolling state.** A contract is not auto-renegotiated
when its window elapses (see §5); it rolls on under the same terms until a party reopens it. Once
`state.tick ≥ signedTick + windowDays × windowN`, `remainingCycles` is 0, so the fee is 0 and (below) no lockout
is written. This is intended: the onus is on the Syndicate to come back and renegotiate; between window-end and
that renegotiation, walking is free of fee. It falls straight out of the formula rather than needing a special
case.

**The fee may drive credits negative**, exactly as the §5 breach fee may (`docs/licence-and-price-system.md` §5;
guild credits are non-negativity-exempt, invariant 2 stays exact: guild −X, ledger +X). It is charged in full
whether or not the guild can pay. *This is a stand-in: the intent is that a teardown cost should bottom out at
zero credits, and later mechanisms (debt handling, and the broader venture-management economy) will replace the
"go negative" behaviour. Until they exist, negative is the honest, conservation-clean placeholder — a guild in
debt is a pressure state, not a broken ledger.* Recorded so a future session does not read the negative as
intended and final.

### 3.3 The node lockout — the node (self-denial), and the one new stored state

The mean line and the fee both ignore **territory**: that the venture sat on a scarce node. A node stays inside
the owning guild's territory when its venture is torn down — rivals cannot take it (it is claimed land). So the
lockout is pure **self-denial**: the Syndicate bars the **owner** from re-establishing on that very site until
the contract term it abandoned has elapsed.

New top-level state, the first "this site is unavailable with no venture on it" fact in the engine:

    state.nodeLockouts: [ { siteId, releaseTick, lockedAtTick } ]

- Written on tearing down an **ordinary-licensed** venture with contract time left, with
  `releaseTick = licence.signedTick + licence.windowDays × windowN` (= the "remaining current period"; if the
  contract has already rolled past its term, `remainingCycles` is 0 and **no lockout is written**).
- **`lockedAtTick = state.tick`** (§15.2, every mutation records its tick).
- **Omitted when empty** — a galaxy with no lockouts carries no `nodeLockouts` key, so every existing
  determinism golden stays byte-identical (nothing holds a lockout).
- **Establish gate.** `establishVenture`, `establishDeuteriumRefinery` and any other seat-a-venture action gain
  one refusal in `validateAction`: a site whose lockout has `state.tick < releaseTick` is refused. It gates
  **any** establish, including the owner's — which is the whole point, since only the owner could build on their
  own territory anyway.
- **Lazy expiry.** Nothing sweeps per tick; the establish gate reads `state.tick ≥ releaseTick` as "free", and a
  dead entry is pruned when next touched (a re-establish on that site). Deterministic and cheap.
- Joins serialize/clone (`sim/state.js`, `sim/persist.js`) and the snapshot; `releaseTick` is absolute, so it
  survives a save/reload like a shipment's `arrivalTick`.
- **New invariant `checkNodeLockouts`** (`sim/invariants.js`): `nodeLockouts` is an array; each entry has a real
  seed `siteId`, an integer `releaseTick > lockedAtTick`, an integer `lockedAtTick ≥ 0`.

## 4. Unlicensed ventures — trivially clean

A venture with no `venture.licence` owes no contract, so its teardown is: remove it, free site and asset, and
`guildReputation -= (reputation || 0)` (≈ 0 for these). **No fee, no lockout.** This one path covers the ordinary
unlicensed mine/factory, the **unlicensed deuterium mine**, and the **illegal deuterium refinery** alike — none
of them carries an ordinary licence, so none has a term to pay out or a node to lock. (There is an advantage to
unlicensed ventures here, by design — the cost of operating off the Syndicate's books is that you never had its
standing to begin with.)

## 5. `windowDays` is activated — teardown is its first reader

`licence.windowDays` (7–42, `sim/licence.js`) has been stored at signing but **inert** — the comment in
`sim/licence.js` notes that resolving it to a tick "is renegotiation, which this slice does not build." Teardown
is its **first consumer**: it reads `windowDays` to price the settlement and set the lockout release, resolving
days→ticks as `windowDays × windowN` (a cycle is a day, `sim/windows.js`). This is a use of the stored term, not
renegotiation; renegotiation (#64) — reopening the terms once the window elapses — is still unbuilt.

**Note for the renegotiation design (#64), captured here so it is not lost:** the commitment window carries **no
signing-time price signal** — `feeFraction` depends on commitment and equity, not on `windowDays` — so nothing at
signing makes a longer window cheaper, and a purely rational player minimises it. This is **left to the
Syndicate's renegotiation behaviour** to correct, not to a fee curve: the greedy short-term player is met by the
Syndicate coming back to demand a longer commitment (and charging more on refusal). That intent lives only here
until #64 is built; #64 inherits the job of giving long-vs-short term its meaning.

## 6. Deuterium hardening — DEFERRED (licensed deuterium mine)

The **licensed deuterium mine** is refused by `decommissionVenture` this slice, with a message pointing here. Why
defer rather than allow it:

- It is **windowless** (no `licence`, no `windowDays`), so "remaining cycles" and "contract end" are undefined —
  the §3.2 fee and §3.3 lockout have nothing to compute from.
- Its real deterrent is **already automatic**. A licensed deuterium mine is **pure RP, zero GP** (a 1000 signing
  bump + 50/cycle, `docs/points-and-reputation.md` §2.6 / `fuel-supply-and-allocation.md` §1.4). Tearing it down
  vaporises ~1000+ RP with **no GP to offset it**, so the gap falls harder than for any market venture — the
  guild's whole fuel modifier drops, toward the floor for a guild that was relying on that RP. So there is **no
  cheap-walk window to fear** even with the rest of teardown live; the mean line already makes walking deuterium
  the harshest teardown in the game.

The hardening slice will add: a **forced minimum term** on the (currently windowless) deuterium licence — new
structure, and the reason this is its own slice — so the Syndicate can hold deuterium supply for a guaranteed
stretch (a **supply-security** goal, distinct from punishment, which the RP-crash already delivers); and the
**§7 surveillance hook** — walking a licensed deuterium mine raises the guild's surveillance level, making any
later illegal deuterium operation likelier to be detected (a punishment **conditional on the crime** — harmless
to an honest walker, a head start against a smuggler). The surveillance hook depends on §7 detection, which is
inert, so it too is captured-and-deferred here, not built.

## 7. `teardownSettlement` — one source of truth for the numbers

A pure helper `teardownSettlement(state, guild, venture) → { settlementFee, lockoutUntilTick, rpForfeit }`
(licence layer, `sim/licence.js`, beside `feeOwed`) computes the settlement once. The **apply** charges exactly
what it returns, and the **snapshot** exposes it so the client's confirm can preview the exact cost before the
player commits — the settlement the player is shown and the one the engine charges cannot disagree, by
construction. It reads; it never writes.

## 8. Failure modes hunted on paper (working rule #7)

- **Orphaned window accrual.** `guild.syndicateWindows[systemId][good]` (delivered-so-far) is per-good, not
  per-venture. Tearing down the last committing venture for a good mid-window leaves that state with delivered
  units and no venture to meet/breach at the boundary. Expected benign (derived `Q` = 0, no verdict, no fee), but
  it must be **tested**: tear down mid-window, tick past the boundary, assert no throw and no phantom charge.
- **Lockout across save/reload.** `releaseTick` absolute; must serialize and restore. Tested.
- **No bump farming.** Sign 100% for the 2× bump, tear down before delivering → the bump leaves with
  `venture.reputation`; `checkGuildReputationSum` stays exact and no RP is kept. Tested.
- **Unlicensed teardown** must never price a fee off an absent licence (no `licence` → fee 0, no lockout).
- **Negative credits** are allowed here (§3.2), the same carve-out the breach fee runs under.

## 9. Invariants & tests

- `checkGuildReputationSum` stays exact after a teardown (the key correctness test).
- Site freed: `computeOccupancy` no longer names the site; a fresh establish on it succeeds **unless** locked.
- Asset idle: `idleAssets` includes the freed asset; it can be redeployed elsewhere.
- Lockout: establish on the locked site is refused while `tick < releaseTick`; succeeds at/after it; the entry
  prunes on that re-establish.
- Fee: `syndicate.ledger += settlementFee`, `guild.credits -= settlementFee` (invariant 2 exact; may go negative).
- GP drops by the venture's weight (derived), verified via the snapshot's `guildPoints`.
- `checkNodeLockouts` shape check, wired into `checkInvariants`.
- **Determinism / goldens:** `decommissionVenture` is a new action no existing golden scenario calls, and
  `nodeLockouts` is omitted-when-empty, so **no existing determinism golden moves.** A new scenario exercises the
  action; state written by it carries the new field.

## 10. Ruled (07-09-26) and explicitly NOT built

**Ruled:** (1) licensed-deuterium-mine teardown is DEFERRED (§6); (2) the settlement fee may drive credits
negative, a stand-in for later debt mechanisms (§3.2); (3) `remainingCycles = windowDays − floor((now −
signedTick)/windowN)`, current partial cycle counted whole (§3.2); (4) the action is `decommissionVenture`; (5)
the node lockout is self-denial only, keyed by `siteId`, gating any establish including the owner's (§3.3).

**NOT built, and nothing approximates it:** the deuterium forced term and the §7 surveillance-on-walk hook (§6);
renegotiation (#64), which teardown does not touch; any venture *transfer*/sale (a separate future market, not
teardown); a debt/credit-floor mechanism to replace §3.2's negative-credits stand-in.
