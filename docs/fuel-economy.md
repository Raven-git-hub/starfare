# Fuel Economy — design-pass handoff (WORK IN PROGRESS)

*Status: **design-in-progress, not a settled spec, and — with the one exception below — not built.**
This captures the fuel model as sketched on 30-08-26 so a future design pass can resume without
re-deriving it. It **refines §8** (the Syndicate fuel utility) — where it changes a §8 statement, it
says so. Do not turn any of this into a build prompt until the open questions (§9) have had a real
design pass.*

*The exception, 31-08-26: **§7's starter floor is BUILT** (fuel Slice 1) — a founding guild now opens
with a baseline hoard, so `fuelHoard` is finally a live number instead of a permanent zero. Nothing
else here is built: no pool, no allowance, no reputation, no Guild Points, and nothing spends fuel.
See the BUILT note under §7.*

## 1. The core idea — fuel is the cost of doing Syndicate business

Both **BUY and SELL** to the Syndicate consume fuel. Fuel is rationed to each guild as a per-cycle
**allowance** (a "fuel credit"), sized by contribution, so trade is never free and the Syndicate
rations the one thing everyone needs. This is what makes the Syndicate premise *bite* even with a
single guild in the galaxy — without it, the institution that controls the fuel utility lets everyone
trade for nothing.

## 2. The allowance — a designed curve of reputation-for-size

Each **cycle** (1,440 ticks / 24 h — reuse the existing window boundary) a guild is granted a
fuel-credit allowance, computed at cycle start. The allowance depends on the guild's **reputation**
measured against a **designed expected-reputation-for-size curve** (the "mean line"), where size =
**Guild Points** (§4).

- **The mean line is a DESIGNED curve, not a live population average (ruling).** For a guild of Guild-
  Points size X the curve gives an expected reputation Y; the guild's *actual* reputation vs that
  expectation sets its allowance — above the line → buff, below → penalty. A designed curve **works
  with one guild**, is directly tunable, and a population-relative version is a later refinement. This
  ruling is what lets fuel ship before bots exist.
- **Everyone can be above the line** — it is an absolute standard, not a ranking. When all guilds
  contribute well, all earn buffs, **collective fuel demand rises, and fuel PRICE becomes the real
  throttle**. Universal cooperation is therefore a flat, high-price equilibrium that flattens
  individual advantage — which is precisely the opening for a guild to **go rogue** (contribute less,
  or refine illegally) to steal an edge. The scarcity pressure is *price*; the line is the *relative
  reward*.

## 3. Reputation — fluctuating, relative-to-expectation, per action

Reputation is a moving score driven by **every action that could contribute to the Syndicate**, each
judged against an **expected** contribution: do more than expected and it rises, less and it falls
(e.g. if a guild is "expected" to deploy a venture at ~50% of some contribution combo, exceeding it is
a plus and under-shooting a minus). It goes **up and down** — distinct from Guild Points, which only
rise.

> **GROUNDING (checked 30-08-26): reputation does NOT exist in the engine yet.** What exists is
> `influence` (a governance / voting weight, §7 — starts at 100 for the player) and the licence
> `equityPct` lever. **Neither is Syndicate-contribution reputation.** Invariant 8 names reputation as
> a rule (#61) but the event list is unspecified and unbuilt. So the reputation event list + its
> per-action expected values is **greenfield design**, not an existing lever to read.

## 4. Guild Points — cumulative size/footprint, monotonic

Guild Points go **up with each qualifying action and stay fixed** — a running measure of how big a
guild is (contrast reputation, which fluctuates). Sources (weights TBD): **asset deployment** (more
for higher tiers), **node usage**, **exploration** (size of the info database), **outposts**, **tolls**,
**scanners**, **transports**, and **number of controlled systems**.

- **Density beats sprawl (ruling):** node usage is worth far more than raw system count — 2 nodes in 1
  system out-scores 4 systems with 1 node each. An anti-landgrab incentive baked into the score.
- **Dependency:** asset deployment is a Guild-Points source, so Guild Points cannot be honestly
  computed until the **asset economy exists** — which is exactly why assets are built first.

## 5. The two-stock / illegal-refining structure — acknowledge now, build later

Two quantities, not one: the **legal allowance** (metered per cycle) and a **physical fuel stock**
(legal purchases + illegally refined fuel) that trade actually burns. The Syndicate can't see the
physical stock, but it meters **fuel-credit usage on Syndicate routes**; when usage implies more fuel
than the allowance could cover, illegal refining is **inferred** → risk of a steep fine (§7/§8).
**Scope for now: leave room in the structure (two stocks + a usage meter); the full detection mechanic
is deferred.**

## 6. Background deuterium floor — softens §8's "no infinite backend"

**Ruling (30-08-26, refines §8):** the Syndicate has a **background minimum deuterium source** — a
life-support floor for extreme shortages so fuel can't collapse to zero and hard-lock the game.
Implementation open — a deuterium-producing bot, or a hidden engine ticker. This **softens** §8's
stated property that "the allocatable pool is exactly the surplus net-producers deposit / no infinite
backend": the pool is now **guild deposits + a background minimum floor**.

## 7. New-guild death spiral — handled by balancing, not structure

A new guild starts at ~0 Guild Points / ~0 reputation; the no-fuel → no-trade → no-reputation trap is
handled by **early-game balancing / a starter floor** (straightforward with testing), anchored on §8's
"survival floor" — not a structural redesign.

> **BUILT 31-08-26 — the starter floor, and ONLY the starter floor (fuel Slice 1).** This paragraph is
> the ruling `foundGuild` now implements: a founding guild opens with `GUILD_STARTING_FUEL`
> (`[FIRST-CUT]` **500**, `sim/fuel.js`, recorded in `docs/phase-1-tuning.md` §"Guild starts") in its
> hoard instead of the 0 the apply used to force. Before this, `guild.fuelHoard` was a real, validated,
> snapshot-exposed field that was always zero, because minting fuel needed a fuel-genesis rule that had
> not been ruled — this is that rule, and nothing more.
>
> **What it is NOT.** It is not the §2 allowance: there is no pool, no issuance, no per-cycle top-up, no
> reputation and no Guild Points behind it. It is a one-off grant at founding and then the hoard simply
> sits, because **nothing in the engine spends fuel yet**. Every open question in §9 is still open.
>
> **The two seams it had to respect**, recorded here because they are where a future fuel change will
> break: the grant is *minted*, not moved (there is no fuel counterpart to the Syndicate ledger), so the
> apply adds it to `audit.totalProduced` or **invariant 1** unbalances on the tick a guild is born; and
> it refreshes the `galacticSupply` cache in the same apply, because `POST /action` asserts every
> invariant with no tick in between and a stale `fuel.guildHeld` trips **`galactic-supply-consistency`**.
> Any later code that moves a `fuelHoard` owes both.
>
> The snapshot also gained `guild.fuelHoardValue` — the hoard in credits at a flat `[FIRST-CUT]` rate,
> since §9's question 4 (how fuel is priced) is unanswered and fuel has no posted price (§8). See
> `docs/client-wiring.md`'s closing revision.

## 8. HUD (later)

Physical fuel quantity + its fuel-equivalent; the guild's fuel-credit **rating** (cycle entitlement,
computed at cycle start); and a view of **legal vs illegal** fuel stock and the resulting total.

## 9. Open questions — the real design pass

1. The **reputation event list** + per-action expected values (greenfield; ties to #61).
2. The **Guild Points formula** — source weights, and the density-over-sprawl shape.
3. The **mean-line** shape (expected reputation vs Guild Points) and the map from position → allowance
   (buff/penalty magnitude).
4. **Fuel price** — reuse the price engine (fuel is currently *never* priced, §8) or a dedicated
   reserve-based curve? Fuel pricing is itself a subsystem.
5. The **per-transaction fuel cost** for BUY and SELL — flat, or scaled by qty/distance.
6. The **two-stock + illegal-detection** mechanic (deferred; structure-only now).
7. The **background deuterium floor** — bot vs hidden ticker, and the floor level.
8. **Sequencing vs §8**: can the fuel-credit layer + a background floor stand first, or does it need
   the deuterium mining / Syndicate refining machinery built underneath it?

## 10. Relationship to §8 (one line)

This is §8's "allocation as purchasing power, contributors get priority, need-responsive" made
concrete — the reputation / Guild-Points / mean-line is the **formula for how much allocation** a guild
gets. §8's deuterium mining + refining monopoly + scarcity pricing is the physical layer beneath it.
