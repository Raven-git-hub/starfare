# Starfare — the Syndicate economy: licence layer + price system (design + build roadmap)

Consolidates the design session of 26-08-26. This is the reference the ruling doc-commits and the Claude
Code slices get drawn from. Where our design **ratifies or refines** an existing design.md ruling it says
so — a lot of this is already in §5/§7/§8 and must be reconciled, not reinvented (seam rule).

> **Status — a design roadmap that evolves.** Like everything in §17, this changes as the design
> develops; nothing here is frozen. The **price** rulings are settled; the **licence** rulings are
> *proposed* and get reconciled against §5 when the licence slice is built — do not treat the licence
> sections as final over §5 yet.
>
> **Relationship to design.md §5 (read this).** §5 already carries most of the licence / equity /
> reputation / leasing layer in **more** detail than this doc — the four-corner fee grid, the 49% equity
> ceiling, the `o^k` shaping, the Land-Owner/Venture-Owner leasing split, takeovers, forced closure,
> dissolution payouts, tanking-as-a-feature. **Build those to §5, not to this doc.** What this doc adds on
> top of §5 is only:
> - **Supersedes §5 (settled):** the Syndicate price **direction** — the value now *rises* with
>   guild-held stockpile and falls as hoards drain, not "abundance commands worse prices" (a pointer is
>   added at §5's Exchange). The price **formula + per-tick cadence** fill the empty `stepPriceRecompute`.
> - **Proposes, pending reconciliation at the licence slice:** a **price-linked basic fee at issuance**
>   (vs §5's flat-per-type, open #56); a **per-tick** commitment sale (vs §5's per-cycle); the
>   **reputation tiers / thresholds / build rates** (a proposed answer to §5's open #61); and a
>   **+10%-per-tier dividend bonus** (new). These are **not yet ruled over §5** — they're the agenda for
>   the licence slice, not settled law.

## The two governing principles
- **Pressure over prohibition** (existing) — rules bend, they don't hard-block.
- **Release valves, not airtight systems** (new this session) — no single system has to be fair or
  exploit-proof on its own, because pressure in one is *meant* to escape into others as drama (transport,
  commissioning, the council, the storyteller, bots). A cornered good sends you elsewhere; the leak is the
  gameplay. **Add both to design.md as first-class principles.**

---

## Part 1 — The price system (settled)

A per-good Syndicate **value**: the "one true number" the whole economy is denominated in.

- **One number per good.** The Syndicate is a market-maker with inexhaustible tier-1–3 stock; it buys
  **and** sells at that single value (keeps §8's structure). The player **order book** sits alongside it
  (Phase 3). Fuel is **never listed** (Syndicate-regulated).
- **Direction flipped (a deliberate §8 override).** The value **rises** as a good sits in guild
  stockpiles and **falls** as those hoards drain — because the Syndicate can't produce, so a hoard *is*
  its scarcity. This overrides §8's "abundance commands worse prices." Player mental model:
  *"the Syndicate bids up whatever's being hoarded to pull it loose."*
- **The formula shape** (constants all `[FIRST-CUT]` → `phase-1-tuning.md`):
  - **Level** (main driver) = `totalGuildStockpile ÷ productionCapacity`, where capacity = Σ of the
    fixed droidless baseline outputs of every venture making the good. This is **rarity-aware for free**
    (few producers → any hoard is a big disparity → sharp price; many → gentle) and **self-correcting**
    (drains → ratio falls → price crashes). Both inputs are already derivable.
  - **× Idleness** (the behavioural term) = discount the value for stock being **consumed downstream**
    (working inventory), bid it up for **static** stock (a hoard). Read from the production block's
    `demand`/`fork.downstream` — a single-snapshot signal, no new state. This is what distinguishes a
    vertically-integrated guild's *working* pile from a *hoard*.
  - **EMA-smoothed, per tick.** Recompute every tick (short-term engagement) but glide toward the target
    via an exponential moving average, so it moves visibly without strobing. The EMA's memory **folds in
    the momentum/trend term for free** — a building hoard makes the price climb tick-over-tick.
  - **Published two ticks behind.** The posted value this tick is derived from state two ticks ago. This
    (a) breaks the price↔action circular dependency, (b) restores §8/#42's *knowable* posted price, and
    (c) creates a **front-running game** — the real stock is visible now, the price catches up later, so
    watching the stock (not just the price) is a skill edge.
  - **Slew-capped** (max move per tick) so a single dump can't teleport the price, and **clamped** to a
    soft floor/ceiling.
- **Cadence = per tick**, lagged 2, EMA-smoothed. (A further deliberate override of §8/#42's per-window
  posting — recorded, not drifted.)
- **Bounded by** the hard ceiling (technical stop), the **storyteller** as the intended circuit-breaker
  (Phase 6), and **destabiliser/counter bots** as the interim rope until then.
- **Self-consistent with the licence goal by construction:** committing or selling to the Syndicate
  drains guild stock → drops the level → lowers the price. The institution literally pays less once the
  hoard it wanted is loosened; the flywheel rewards the behaviour it exists to create.
- **Tier 4** (ships, rigs, factories, outposts, toll gates) is **not** priced by this function — the
  Syndicate builds it **on demand at component cost** (§8 lines 453–457, already ruled). Its *inputs*
  (tier 1–3) are priced normally, so a corner shows up as build cost, never as denied access.

---

## Part 2 — The licence layer (settled; reconcile with §5/§7)

- **A licence is a contract, not a gate.** Voluntary. You may run **unlicensed** ventures; they simply
  get no Syndicate benefits. (Aligns with the ungated-establishment call.)
- **Commitment.** The player offers a **percentage of the venture's fixed droidless max output**, which
  the Syndicate translates to a **fixed quantity `Q` per 24h cycle** (per **venture**, even for two
  ventures making the same good). The Syndicate doesn't negotiate — it has **fixed terms** keyed to what
  you offer, because it already knows every venture type's max output. *(This is §5's Q — the fork
  minimum and dividend base — with the "% of a known max" front-end added.)*
- **Commitment is a SALE, not a tithe.** Committed goods are **sold to the Syndicate at the current price
  and paid in credits, per tick.** The cost of the licence is the fee + equity cut, not the goods. This
  is the keystone that makes the deal feel voluntary.
- **Fee.** An **ongoing** fee, **locked at issuance** (rewards reading the market and timing your lock),
  sized as a percentage of a **24h production's value at the current price**, and **discounted** by your
  commitment %, equity %, and reputation. Shown accruing **per tick**; **breach/meet judged at each 24h
  mark**. *(§8 line 234: fuel excluded from this fee model — it's a monopoly, not a licence.)*
- **Breach = void the discount + a reputation hit.** Under-deliver `Q` in a cycle (dial the fork down, or
  starve a downstream refinery) → pay the **full basic fee** instead of the discounted one (§5, already
  ruled), **and** take a reputation drop. The **breach formula is reputation-based and escalates** with
  repeated/continuous offences; the credit penalty is just "lose the discount," fixed.
- **Equity (independent 0–X% lever; investor market deferred).** Selling equity assigns a share of the
  venture's **post-Syndicate-sale credit** to **investor guilds** (or the Syndicate if none), **per
  tick**. In return you get **reputation + a fee reduction** (and possibly a fuel credit — to decide). It
  does **not** touch the resource commitment, so breach stays resource-based. The **investor market**
  (guilds buying/selling stakes in each other's ventures) is a whole layer — **defer the behaviour, but
  reserve the live-state shape now** (a cap-table on the venture). *(This is §5's leasing/dividend model
  — build on it.)*
- **Reputation (per venture; reconcile numbers with §5/§7).** Starts at **0**; climbs to **+1000 in 10
  tiers**, each tier granting **+10% dividend to all shareholders** (owner included), printed by the
  Syndicate — the long-game cash-cow that makes high-rep shares valuable. Falls to **−500 in tiers of
  100**: at **−300** the venture is **forced-lease-eligible** (offered to the biggest stakeholder), at
  **−500** it's **closed and the licence revoked** (+ possible node lockout). Builds two ways: a **fixed
  rate** just for holding a licence, and a **variable rate** rewarding meeting targets (more for bigger
  commitments) and punishing misses (more for *smaller* commitments). **Guild reputation = Σ of its
  ventures' reputations.** *(§5/§7 already make reputation load-bearing for takeover, forced closure,
  share value, payout, and standing — our tiers/thresholds must be reconciled against those, not layered
  on top.)*
- **Fixed output per venture TYPE.** A mine/factory produces a constant baseline (droidless). **Throttle
  goes below**, **droids go above**; the Syndicate accounts only for the **droidless max**. *(This must
  become a real constant table — today `productionRate` is a free per-venture dial.)*
- **Cadence.** Commitment/fee/breach run on the **24h cycle**; equity dividends **per tick**; the
  **licence length (7–42 days)** is only the **renegotiation-eligibility** point (either party may
  reopen; otherwise it runs on indefinitely). **Window length carries no fee premium** — short-window,
  frequent-login play is deliberately rewarded.

---

## Part 3 — What already exists (build on this, don't rebuild)

- **Commitment engine:** `venture.syndicateCommitment`, `guild.syndicateWindows`, the per-good aggregate
  target `Q`, the Syndicate fork delivering toward `Q` (capped at `Q`), `windowN`. Testbed dials
  `setSyndicateCommitment` / `setWindowN`. The licence layer *drives* these instead of the dials.
- **Production resolver** (`production.js`): mining, T1→T2 refining, the three distribution gates
  (syndicate / downstream / stockpile), reserve, `batchCarry`, throttle (on refineries).
- **Breach already designed** in §5: shortfall → full fee; teardown rules; no-clawback.
- **Price step is a stub:** `stepPriceRecompute` exists in the tick order (step 3) but returns state
  unchanged — **no price fields on state yet** (§8/#42). This is the empty socket the price engine fills.
- **Inputs are already live:** `galacticSupply` = Σ guild stockpiles (the **level** numerator);
  `production[].goods[good]` carries `fresh`/`demand`/`fork` (the **idleness** signal).
- **Fuel** is a conserved pool (`fuelHoard` + communal `reserve` + in-transit) with a hard conservation
  invariant, and a fully-designed **allocation-as-purchasing-power** model (`fuel-allocation-model.md`,
  §8 501–515). Excluded from pricing and the fee.
- **Reputation / leasing / takeover / forced closure:** extensively designed in **§5/§7** — not built.
- **The console** (just repaired): Syndicate tab, MOCK licence roster + thermometer, the distribution
  sliders (now working), the price chart (currently a client-side ring buffer). All waiting to bind to
  real state.
- Schema **7**; determinism (invariant 9) holds; the tick order is a fixed contract.

---

## Part 4 — The build roadmap (dependency-ordered slices)

**Slice 0 — Rulings → repo (the gate).** Paste-ready design-doc commits: the two principles; the §8
price-direction + per-tick overrides; the price formula; the licence contract (Part 2), reconciled
against §5/§7 so there's one story, not two. **Nothing builds until the repo says it** (seam rule).

**Slice 1 — Fixed output per venture type.** Make baseline output a **constant per type**, not a free
per-venture number; `productionRate` becomes throttle-below / droids-above around it. Small, but the
commitment and fee math both stand on "the Syndicate knows your max."

**Slice 2 — The price engine. ✅ LANDED 26-08-26** — build note: `docs/price-engine.md`; constants:
`docs/phase-1-tuning.md`. Filled `stepPriceRecompute`: per-good price rows on state (`posted` + the
`PUBLISH_LAG`-deep pipeline whose last slot doubles as the EMA memory); `level × idleness`; EMA; the
2-tick publish buffer; slew cap; floor/ceiling; fuel excluded permanently. The capacity normaliser reads
a new `[FIRST-CUT]` **droidless baseline** table (`sim/baseline.js`) — *not* `productionRate`, which is
NOT refactored here. The posted value is in the snapshot (additive, schema still 7); no history on state,
so the console keeps its ring buffer until the chart-binding slice. Tests as specified, plus the
empty-galaxy no-op proof. **Nothing consumes the price yet** — that is Slice 3.
Still open and NOT invented: per-good base prices, per-resource baselines, whether the level curve stays
linear, and Part 5's normaliser confirm.

**Slice 3 — Licence + commitment-as-sale + fee (credit side).** Replace the testbed commitment dial with
a real **licence entity** (commitment %, fee terms **locked at issuance**, 24h window; reserve the
`equityPct` + cap-table fields now). Committed goods **sold at the posted price → credits/tick**. The 24h
**breach check** → discounted vs full fee. (Reputation consequences land in Slice 4.)

**Slice 4 — Reputation.** Per-venture score, tiers, the fixed + variable build rates, the breach
reputation penalty, the per-tier dividend multiplier, guild total. **Reconciled with §5/§7 thresholds.**
Define the forced-lease (−300) and closure (−500) triggers (the *takeover mechanic* itself can wait for
Slice 5).

**Slice 5 — Equity + the investor market.** Equity share of post-sale credit, the venture cap-table,
dividend distribution to investors, guilds buying/selling stakes, forced-lease takeover, forced closure.
The big one; fields reserved back in Slice 3.

**Slice 6 — Wire the console.** Turn the Syndicate tab from MOCK to real: the licence roster, the
thermometer (real `Q` fulfilment), the fee/breach/pursue controls, the real price chart. Can be done
incrementally after Slices 2/3/4 rather than all at once.

**Slice 7+ — Ecosystem.** Destabiliser/counter **bots** (the interim volatility + circuit-breaker); the
**player order book** and open market (Phase 3); **tier-4 commissioning** (§8, already designed); the
**fuel-allocation** build; the **storyteller** (Phase 6). The fuel-credit licence carrot rides the fuel
session.

---

## Part 5 — Still open (rule before or during the relevant slice)
- **All `[FIRST-CUT]` constants:** price curve steepness, floor/ceiling, EMA alpha, slew cap, the lag (2),
  fee %, reputation build/decay rates and tier thresholds, equity caps. → `phase-1-tuning.md` / the
  decision checklist.
- **The §5/§7 reconciliation** — our reputation/equity/breach numbers vs. the ones already committed. Do
  this *in* Slice 0 so the repo tells one story.
- **The breach reputation *formula*** (the escalation curve) — the last real ruling Slice 4 needs.
- **Equity/investor-market mechanics** — the deferred deep layer (Slice 5).
- **The fuel-credit carrot** — deferred to the fuel/reputation session.
- **Normaliser confirm:** live production capacity (recommended) vs a fixed per-good reference.
