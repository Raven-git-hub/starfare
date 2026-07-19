# Fuel Allocation & Production — What This Thread Decided

*A self-contained design summary of the fuel pool, allocation, and refinery-licensing model. Supersedes the committed-capital allocation ratio from the earlier fuel-policy thread as the **allocation** mechanism (it borrows one trick from it — see §9). Written to be pasted into design.md §8 or into a fresh session; nothing here has touched the doc yet.*

---

## 1. The core reframe: source and distribution are one pipe

Two questions were tangled and separating them dissolves most of the problem:

- **Source** — where does fuel physically come from? (Pure conservation.)
- **Distribution** — who gets to draw it, and how much?

They *feel* like two systems to bolt together. They are the two ends of **one pipe**: the fuel handed out as allocation can only ever be the fuel surplus producers put in. Design them as a single balance sheet or they won't sum to zero, and the Syndicate ends up minting or burning fuel to cover the gap — the exact failure we're avoiding.

## 2. The pool

Fuel is finite, and — unlike every other good — the Syndicate has **no infinite backend** for it. It cannot on-demand-produce fuel the way it backstops other goods. Therefore:

- The **allocatable pool** equals the net fuel producers deposit as surplus.
- **Per-route allocation is the sink; surplus production is the source.** Same pool, not two systems.
- Conservation is exact: fuel only leaves the pool when it's actually bought, and stops when the pool is empty.

## 3. Allocation is denominated in purchasing power, not physical fuel

This is the key fix. Price can only ration allocation if the allocation is **credits**, not a fuel quantity — a quantity claim can't be scaled by price, only by cutting the multiplier (the 1.1→0.7 move we rejected).

So: **grant credits sized to buy ~1.1× the route's fuel burn at a reference price**, then let the reserve-based price float on the pool level (the curve the spreadsheet already uses).

- Pool drains → price climbs → the fixed credit grant simply buys less fuel.
- Scarcity is felt as **affordability**, automatically, individually, decentralised — each guild discovers its own shortfall. No central multiplier-cutting.
- This is the elegant form of the pro-rata cut: same conservation, already built and tested.

## 4. Per-route, per-burn sizing (the need-responsive part)

Allocation is sized to a route's **actual fuel burn**, so it's proportional to actual activity.

- Dracis (burns 12) naturally draws more than Ilyra (burns 3). This **answers the "need-blind allocation" open question for free** — need-responsiveness falls straight out of measuring burn, and it's more legible/in-theme than an abstract capital metric (fuel goes to whoever's visibly doing the hauling).
- **Mechanism**: a licence to ship resources from a system to a Syndicate outpost. Allocation per route = purchasing power for ~1.1× that route's burn. Licences are gated on fulfilling quotas over time and on vessel size; allocation adjusts up/down on route productivity, hoarding, etc.
- The **1.1× is a deliberate logistics subsidy** (every route is a slow, small fuel gain, which encourages movement). The quota requirement is the guard against running pointless routes purely to skim the 10%. *Confirm on purpose that the 10% is a chosen subsidy, not an accident.* (1.0× would make routes fuel-neutral.)

## 5. The Syndicate-only fuel benefit, and the regional-faction tension

**Decided**: fuel allocation rewards **only Syndicate-facing trade** (ship-to-outpost). Guild-to-guild peer trades don't earn it.

- *Still undecided*: whether the benefit also covers guild↔guild trades **routed through the Syndicate marketplace**, or only direct Syndicate/Guild trades. Leaning toward the latter as a sharper reward/punishment lever.

**Narrative**: the Syndicate is the whole guild collective, and every guild holds a stake in it. Steering traffic onto Syndicate routes benefits all guilds and quells factionalism — *"use our service, don't hoard fuel, and we'll help protect you against the fuel-spike pressure from guilds that hoard and corner the market."*

**Reconciliation with §5 neutrality.** §5 says trading with the Syndicate is never strictly better or worse than trading with a guild. That principle is about **price** — the Syndicate line vs. the player order book as *venues*. The fuel benefit rides on a *different axis*: it's a logistics subsidy, not a rate. So neutrality holds on price; **the Syndicate competes on fuel access, not on rate.** A peer trade can still be the better price while the Syndicate-facing trade carries the fuel perk. This is a narrow, deliberate §5 amendment — not a reversal — and must be written as one.

**The tension (the compelling part).** The perk is a **centripetal** force (pulls everyone to the shared hub). A cluster of neighbours trading amongst themselves is **centrifugal** (skips the perk, but saves transit time and toll exposure of routing through a distant outpost). A regional bloc forms exactly when **locality beats the fuel benefit**. That's the map and the subsidy arguing, with the answer changing by geography — very Dune (the Imperium wants everything through CHOAM; the interesting players run quiet local arrangements in the corners).

Two things make it work rather than sag:

- **Subsidy strength is a galaxy-character dial.** High → everyone hugs the hub (stable, cooperative, dull). Low → regional blocs flourish (fragmented, volatile, alive). This is a **third self-hoster axis**, orthogonal to Storyteller presets and to bot-electorate composition, and the one that most directly shapes the political map. Capture it as exactly that.
- **The cost that keeps it honest.** A bloc that opts out of the perk *also* opts out of the fuel-spike **protection** the perk buys — so it's structurally **more exposed to a squeeze**. This hands the Storyteller a natural target: a fuel shock lands hardest on the regions that seceded from the pool. The chaos comes with its own built-in consequence; it isn't a free lunch.

**Risk to log (watch, don't solve now)**: this rewards guilds that *start* with good neighbours and clustered territory — geography edges toward destiny. Probably fine (asymmetry is stated design), but "born next to two friendly guilds" shouldn't become a dominant opening.

## 6. Producer rewards and the conditional refinery licence

**Role separation** (this is the "reward must be separate" instinct, made structural):

- **Source side — producers** are paid in **credits + Syndicate standing/influence**. Not in more fuel: they already make fuel, so a fuel reward is circular.
- **Sink side — productive consumers** are paid in **fuel allocation** drawn from the pool the producers filled.

**The refinery licence is a commitment device, not a capacity reward.** A free capacity grant would snowball fuel production toward one guild — the monopoly the whole design exists to prevent. Instead the licence is **discounted, conditional, and ongoing**:

- Example shape: pledge 50% of a fuel venture's output to the Syndicate pool → 75% off the licence. Fail to produce that in a 24h window → pay the full fee. The discount is **rent on continued contribution**, not a one-time grant. Producing more doesn't give you more machines; it keeps your discount alive.
- **Chosen non-linearity (decided): the pledge % required for a given discount rises with production volume.** A small refinery gets 75% off for pledging 50%; a galaxy-dominating one must pledge 70%+ for the same break. This attacks **absolute retained tonnage**, not just the ratio — hoarding gets *vastly* harder as you grow. Intent: if a guild goes the massive-fuel-production route, force it to think and commit properly.
- **Bare (unpledged) licences are priced prohibitively.** A 100%-hoarder isn't blocked (pressure, not prohibition) — they just pay a punishing fee to keep every drop.
- **The gap between the bare fee and the deep-discount fee *is* the price of hoarding**, expressed as licence cost. This is the **rebuilt anti-hoarding mechanic** — it replaces the deleted spoilage/storage/expiry list, as a licensing cost instead: more legible, more in-theme (*the Syndicate doesn't rot your fuel; it prices your membership*). **Do not re-add spoilage on top of this, or hoarding gets double-charged.**

## 7. The self-stabilising loop

The two mechanics pull on the same string, in a good way:

Regionalism makes some guilds contribute less fuel to the pool → pool thins → price rises → licence discounts become **more** valuable (pool access matters more when fuel is scarce) → producers are pulled back toward pledging → pool refills.

That quiet negative feedback is a sign the two mechanics are compatible, not merely coexisting.

## 8. What this resolves or supersedes

- **#31 (squeeze balance)** — addressed: a big guild's big burn now competes for a *fixed* pooled surplus, and purchasing-power rationing means a windfall doesn't buy immunity. No standalone balancing lever needed.
- **#1 (fuel governance)** — given a concrete allocation formula (per-burn purchasing power) and a concrete producer-side mechanism (conditional licensing).
- **§8 anti-hoarding** — the spoilage/storage/expiry shopping list is **deleted**, rebuilt as the bare-licence premium (§6).
- **Need-blind allocation** — solved by per-burn sizing (§4); supersedes the committed-capital ratio on this specific point.

## 9. Critical dependency — force-sell must be dropped

This entire model presumes guilds **can** hoard fuel: the anti-hoarding licence premium only has something to bite on if hoarding is possible. But the current Phase 1 port contract (design.md §8, semantic #2) **bakes in force-sell** — production goes straight to the pool and the reserve is fuel's only counterparty, i.e. guilds *can't* hoard at all.

So this model **requires force-sell to be dropped** (withholding becomes possible, and hoarding is disincentivised rather than forbidden). That decision was already flagged as colliding with the Phase 1 checklist; this model makes the collision load-bearing. **Resolve force-sell before implementing any of the above.** Note the enforcement side of "illegal withholding" (a council vote) is Phase 5 — so in Phase 1 hoarding is *possible and merely expensive*, which is exactly what the licence premium delivers without needing courts.

## 10. Levers to tune (enumerated, not yet valued)

- Route allocation multiplier (1.1×) and the reference price used to size the credit grant
- The reserve-based price curve (already exists in the spreadsheet)
- Base licence fee; max discount %; the pledge-%→discount curve; **how steeply that curve rises with production volume** (the anti-monopoly control)
- The bare-licence premium (= the price of hoarding)
- Quota window length (24h is a placeholder)
- Grace/ramp on legitimate production dips
- **Subsidy strength** (the factionalism dial / third galaxy-character axis)

## 11. Still open — decide on purpose

1. **1.1× vs 1.0×** — confirm the 10% route gain is an intended logistics subsidy.
2. **Marketplace coverage** — does the fuel benefit extend to guild↔guild trades routed through the Syndicate marketplace, or only direct Syndicate/Guild trades? (Leaning: latter.)
3. **Quota-window fairness** — 24h interacts hard with tick rate and async play; a guild that can't log in daily gets punished. Same shape as the vote-window fairness problem (#14).
4. **Legitimate-dip grace** — a refinery knocked offline by a Storyteller event shouldn't lose its discount on the same tick the event hits, or the event does double damage.
5. **Geography-as-destiny** — watch that good starting neighbours don't become a dominant opening once there's real play.
6. **Borrowed from the committed-capital thread**: its hoard-valuation trick still applies — value a hoard at *last tick's* price, and treat licensing itself as the observation — since making allocation/discount drop for hoarding again raises "how much fuel is this guild secretly sitting on."
