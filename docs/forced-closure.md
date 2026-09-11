# Forced closure — the −500 consequence (`decommissionVenture`, Syndicate-triggered)

*Status: **RULED 09-09-26** (design room), the pre-sandbox RP-lifecycle cluster (ruling B3).
Authoritative for what happens when a venture's reputation reaches the **−500 floor**. It
**supersedes** the "⚠ REACHING −500 IS A PIN, NOT A CLOSURE" placeholder on
`Venture.reputation` (`docs/design.md` §15.4). The **−300 forced-lease** tier is **NOT** ruled
here — it stays deferred (it needs shareholders + the leasing system).*

*It **invents no tuning number.** The trigger is the existing `RP_FLOOR` (−500); the node
lockout reuses the licence's own `windowDays` via `licenceEndTick`; the RP/GP forfeit is
automatic. No `[FIRST-CUT]`, no new `phase-1-tuning.md` row.*

## 0. Frame

−500 is the closure tier named in `docs/licence-and-price-system.md` §5/§7. Today a venture
that hits the floor is merely **pinned** there by the clamp and keeps producing, keeps being
judged, keeps paying its fee. This rules the real consequence: at −500 the Syndicate **revokes
the licence, closes the venture, and quarantines its node.** Forced closure is an **involuntary
sibling of `decommissionVenture`** (`docs/venture-teardown.md`) — it **reuses that machinery**,
it does not reinvent it.

## 1. Trigger — at the boundary, when the floor is reached

Reputation moves in exactly one place: the met/breach verdict in `applyProduction`, at the
window boundary (`sim/tick.js`, `after = Math.max(RP_FLOOR, before + applied)`). **Forced
closure fires there:** after a boundary verdict clamps a venture's reputation to `RP_FLOOR`
(−500), that venture is force-closed. Reputation only moves at the boundary, so closure is a
**boundary event** — this is the concrete meaning of §5's "mid-window catastrophe": the crater
lands at the boundary. Only a **breach** can reach the floor (a met gain climbs), so closure is
always a breach outcome. A venture can never *persist* at −500: the first boundary that lands it
there closes it. A **licensed deuterium mine cannot breach** and opens at +1000, so it can never
be force-closed — naturally out of scope.

## 2. Closure pre-empts renegotiation

A licence's renegotiation offer opens **only once its contract window has elapsed**
(`state.tick ≥ licenceEndTick`, `sim/actions.js`), and a post-term licence **rolls on under the
same terms** until reopened — so it keeps being judged and can still breach to the floor while a
renegotiation offer is pending. **Forced closure takes precedence:** a venture reaching −500 is
**closed, not offered (or left in) renegotiation.** Any pending `renegotiationOffer` /
acceptance-window / auto-lapse state for that venture is **discarded** on closure. This is what
makes closure distinct from lapse — the *cratered-too-hard, no escape* outcome — rather than
redundant with it (a merely-bad venture bails at a boundary via lapse; a cratering one is closed
before it can).

## 3. What closure does — reuse `decommissionVenture`, minus the remainder fee

Closure is `decommissionVenture`'s apply, fired by the **engine** instead of by the player, with
**one** difference (§3.4).

### 3.1 RP + GP forfeit — automatic, and INTENDED (the "windfall")

Removing the venture drops its RP from the guild sum (`guild.guildReputation -=
venture.reputation`; a −500 venture therefore **raises** the sum by 500) and its GP (derived,
`sim/points.js`). The mean line converts that into a fuel-modifier swing — and for a wreck
(RP ≪ GP) the modifier **rises**: the guild's fuel goes **up** when it sheds the dead weight.

**This is intended, not a bug**, and it is recorded here with its reasoning so the next rigour
pass does not re-flag it as a reward for tanking:

- It is the guild's standing **returning to the line it should sit on** once the drag is gone,
  and it is **bounded** by the modifier clamp (`ISSUANCE_FLOOR`/`ISSUANCE_CEIL`), so it never
  lifts the guild *above* one that never held the wreck.
- It **cannot be farmed**: tanking is strictly dominated by honest play. A tanker pays the **full
  basic fee every cycle** on the way down, **bleeds fuel** the whole time the wreck drags the
  guild to the floor, loses the venture's output, then loses the venture *and* the node — to
  arrive exactly where a clean guild already sits.
- It is the **same escape-valve logic already blessed** for voluntary teardown
  (`docs/venture-teardown.md` §2: "closing a dud helps, with no special rule") and for lapse
  (`docs/design.md` §5: "forfeiting a negative RP raises the guild sum — a deliberate strategic
  escape").
- `design.md` §7's "a naive build rewards tanking" warning is about the reputation-linked
  **investor payout** (tank to manipulate the payout price) — a **different** mechanic, deferred
  with the payout (§4) — **not** this fuel-modifier swing.

### 3.2 Remove the venture; free the site and the asset

The venture is spliced out of `guild.ventures` (its GP goes with it, derived); its **site goes
vacant** and its **asset returns to idle inventory**, both free and derived
(`sim/occupancy.js`, `sim/assets.js`) — exactly as `decommissionVenture` does. The asset is **not
destroyed** and **not** sent to orbital limbo (limbo is lease-only, §5).

### 3.3 Node lockout — ALL-GUILDS, until the contract's own end

The node is locked through the **existing** `state.nodeLockouts` (`docs/venture-teardown.md`
§3.3): a `{ siteId, releaseTick, lockedAtTick }` entry with

    releaseTick = licenceEndTick(licence, windowN) = signedTick + windowDays × windowN

— **the end of the contract the venture abandoned**, reusing the licence's **own** length. No
new number, no new timeline. The built establish-gate `activeLockoutFor(siteId)` keys on
**`siteId` alone**, so it already refuses **every** guild's establish, not just the owner's —
which **is** the all-guilds quarantine ruled here (a closed guild cannot lease the node out to
dodge the lockout). *(Unlike teardown, whose lockout is framed as self-denial, closure's is an
explicit quarantine; mechanically identical today because leasing is unbuilt, but the intent
differs and will matter once leasing exists.)*

If closure fires **at or past** the contract's end (`licenceEndTick ≤ closureTick` — a venture
cratering after its term has rolled), `remainingCycles` is 0 and **no lockout is written**,
exactly as teardown. This is an **accepted asymmetry** (ruled): timing a crater past the term
dodges the lockout, a small strategic edge the design accepts.

### 3.4 No settlement (remainder) fee — the one difference from `decommissionVenture`

Voluntary teardown bills the abandoned remainder (`remainingCycles × discountedFee`) because the
**owner** chose to walk. Forced closure does **not**: the Syndicate revoked the licence,
cancelling the contract rather than the guild walking out on it, and the **breach that triggered
closure already charged the full basic fee** for that cycle at the boundary (the "breach penalty
already in the licence terms", `design.md` §7). So closure reuses `decommissionVenture`'s lockout
tick, RP/GP forfeit and removal, but charges **no additional fee**.

## 4. Out of scope (deferred, unchanged)

- **−300 forced-lease** (needs shareholders + leasing).
- **Investor payout on closure** (no shareholders yet; `design.md` §7 + open #59). When #57/#59
  land, closure gains the payout leg **and** the §7 anti-tanking **guild-reputation mark** that
  guards *payout* manipulation — a different concern from §3.1's fuel swing.
- **The closure NOTICE** a returning player sees — closure **now writes** a `venture_closed` notice to the event log (`docs/event-log.md`, the event-log engine slice); the **client Notices surface** that renders it for a returning player is a following slice.
- **Licensed deuterium mine** — cannot reach −500 (breachless, opens +1000), so nothing to do.

## 5. Failure modes hunted (working rule #7)

- **Mutating the ventures array mid-loop.** Collect force-closures **during** the boundary RP
  loop, apply them **after** (splice + lockout + reneg-discard) — never remove while iterating.
  The breach fee row for the closing cycle is still recorded and charged **before** removal.
- **Pending reneg state on closure.** Discarded (§2); a test must assert no orphaned
  `renegotiationOffer` / auto-lapse timer survives for a closed venture.
- **`checkGuildReputationSum` stays exact** after removal (`guildReputation == Σ
  venture.reputation + foundingEndowment`): the forfeit and the splice move the sum by the same
  amount, the `decommissionVenture` shape.
- **Determinism / goldens.** No existing golden drives a venture to −500 (goldens are short), so
  the suite is byte-identical except the new tests — **prove it**.
- **Save/reload.** The `nodeLockouts` entry is absolute (`releaseTick`) and already serialized by
  teardown; closure adds no new serialized shape.
- **A venture at exactly −500 in a hand-seeded state** closes on its next boundary verdict
  (benign; note it cannot arise from normal play once closure exists).

## 6. Ruled (09-09-26) and NOT built

**Ruled:** (1) −500 triggers forced closure at the boundary verdict, **pre-empting**
renegotiation (§1/§2); (2) closure = `decommissionVenture`'s removal + RP/GP forfeit + node
lockout, **minus** the remainder settlement fee (§3.4); (3) the fuel-modifier windfall is
**intended**, recorded with its reasoning (§3.1); (4) the node lockout is **all-guilds**,
`releaseTick = licenceEndTick`, **none written** if past term (§3.3).

**NOT built / deferred:** −300 forced-lease; the investor payout + the §7 payout anti-tanking
mark (#57/#59); the closure notice (event-log item); deuterium (unreachable).

## 7. The build

The build slice and its prompt live outside this doc; **this is the ruling the build reads.**
Doc-and-code move together (working rule #2): the build flips `design.md` §15.4's "PIN, NOT A
CLOSURE" note and `licence-and-price-system.md` §5/§7's "forced closure … not built" to **built**
in the same commit.

> **BUILT — the −500 engine slice (09-09-26; `sim/tick.js`, `sim/licence.js`, `sim/actions.js`;
> tripwires `sim/tests/forced-closure.test.js`).** Implemented verbatim and **authored no new
> number** (§0). Three things worth recording here rather than only in code:
> - **The shared closure mutation** is `applyVentureClosure(state, guild, venture)` (`sim/licence.js`),
>   beside `applyLapse`: it does the RP forfeit + removal (§3.1) and the node lockout (§3.3), reading
>   `teardownSettlement` for the lockout tick. `decommissionVenture`'s apply now wraps it with the
>   settlement fee (§3.2); the tick's forced-closure path calls it bare (no fee, §3.4) — so a player
>   teardown and a Syndicate closure **cannot diverge on removal**, the `applyLapse` precedent.
> - **The trigger** is in `applyProduction`'s boundary RP move: a venture whose reputation is `RP_FLOOR`
>   after the verdict is **collected** (never removed mid-loop, §5); `stepProduction` closes the
>   collected ventures **after** the guild's whole fee lump is charged, so each cratering breach still
>   pays its full basic fee this cycle (§1/§3.4).
> - **Pending renegotiation state needs no explicit discard** (§2): the offer, the attention derive and
>   the auto-lapse step (`stepAutoLapse`, step 9 — still ahead in the same tick) all read the LIVE
>   `guild.ventures` array and the venture's licence, so removing the venture in step 1 discards all of
>   it with no stored timer left to fire. Verified by a test that ticks well past any lapse deadline.
>
> **Out of scope, unchanged (§4):** the −300 forced-lease, the investor payout + §7 anti-tanking mark
> (#57/#59), the closure notice (event log), and deuterium (unreachable — a test asserts it never
> force-closes). **Determinism:** no golden run drives a venture to −500 and `nodeLockouts` stays
> omitted-when-empty, so every committed golden is byte-identical (the whole suite, determinism runs
> included, stays green). No decision was DEFERRED that this slice needed — the ruling invents no
> number and none surfaced in the build.
