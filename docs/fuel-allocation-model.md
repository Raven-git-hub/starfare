# Fuel Allocation & Production — What This Thread Decided

> **Superseded in part (05-08-26): the refining monopoly.** §6 (producer rewards / conditional refinery licence) and §9 (force-sell) below are **replaced** by the Syndicate refining monopoly — guilds may not refine fuel at all; they mine and sell raw Deuterium, the Syndicate refines it into the pool. See design.md §8. The allocation side (§§1–5) is unchanged.

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

## 6. The refining monopoly — how fuel enters the pool

**Decided (05-08-26): the Syndicate is the galaxy's sole *legal* refiner of Deuterium.** Refinement can never be licensed to a guild — it is proprietary Syndicate technology and, narratively, an **open secret** (every guild knows every other guild *could* refine). The monopoly exists not because no one else can, but to stop any guild cornering fuel and grinding the galactic economy to a halt — a founding reason the Syndicate was established (design.md §1). This **supersedes** the earlier conditional-refinery-licence / pledge-for-discount / volume-scaling mechanism this section previously described: there is no guild fuel-refining licence to price, so that whole apparatus is retired.

**The pipe (source → pool), keeping conservation exact (invariant 1):**

- **Guilds mine raw Deuterium** under an ordinary venture licence, like any ore (unlicensed mining is illegal on the normal terms, §7), and **sell it to the Syndicate** — a normal good sale paid in **credits + standing**. This is the old "producers are paid in credits, not fuel" reward, moved one step *upstream* to the miners.
- **The Syndicate refines its Deuterium holdings into pool fuel.** The pool can therefore hold no more fuel than there is raw Deuterium mined and delivered — the **no-infinite-backend** property (§2) is preserved by construction.
- **Guilds obtain fuel only by buying it from the pool** with their purchasing-power allocation (§§3–5), plus their own credits for anything beyond it.

**Hoarding is legal — but only the fuel you bought.** A guild may sit on purchased fuel and refuse to burn it; that is the "we look after the little guy" allocation working as intended. It is self-limiting: allocation is sized to *actual burn* (§4), so a war-chest means buying the excess at full market price, which the price curve makes expensive as the pool thins. No spoilage/storage/expiry mechanic on top (do not re-add one).

**Refining your own is the crime.** A guild *can* illegally mine-and-refine off the books into black-market fuel — **pressure, not prohibition** — but if caught pays a **steep fine** (§7), tuned to sit just on the line where the risk is sometimes worth taking. So the fuel schemer is now either a **legal buy-and-hold hoarder** of purchased fuel or an **outright criminal** running a black-market reserve — strictly more jeopardy than the old legal-hoard model, and better for it.

**Detection** rides the same volume-based signal as any unlicensed over-production (a black-market fuel op moves more fuel than a guild's legal purchases can account for); enforcement is the §7 legality/fine system, which is Phase 5 — so until then illegal refining is *possible but unpunished in code*, and the Phase-1 default is simply that guilds don't refine (§9).

## 7. The self-stabilising loop

The two mechanics pull on the same string, in a good way:

Regionalism makes some guilds contribute less raw Deuterium to the Syndicate → pool thins → price rises → **selling raw Deuterium to the Syndicate becomes more rewarding** (and buying fuel back more painful) → more is mined and sold, the Syndicate refines more → pool refills.

That quiet negative feedback is a sign the two mechanics are compatible, not merely coexisting.

## 8. What this resolves or supersedes

- **#31 (squeeze balance)** — addressed: a big guild's big burn now competes for a *fixed* pooled surplus, and purchasing-power rationing means a windfall doesn't buy immunity. No standalone balancing lever needed.
- **#1 (fuel governance)** — given a concrete allocation formula (per-burn purchasing power) and a concrete producer-side mechanism (conditional licensing).
- **§8 anti-hoarding** — the spoilage/storage/expiry shopping list stays **deleted**; anti-hoarding is now the **refining monopoly + legality** (§6), not a licence-cost premium (the earlier bare-licence-premium rebuild is itself superseded — there is no guild fuel licence to price).
- **Need-blind allocation** — solved by per-burn sizing (§4); supersedes the committed-capital ratio on this specific point.

## 9. Force-sell is moot under the refining monopoly

The earlier model presumed guilds *could* legally refine and hoard their own fuel, and asked whether to drop **force-sell** so hoarding became possible-and-priced. The refining monopoly (§6) settles it from the other side: **there is no legal guild fuel production at all**, so there is nothing to force-sell. The Phase-1 default is simply that **guilds do not refine fuel**; legal hoarding exists only via *purchased* fuel (§6). Illegal refining is possible in fiction but unenforced until the §7 fine system lands (Phase 5). Design.md open question #48 is reframed accordingly: not "keep or drop force-sell," but "guilds don't produce fuel; the pool is Syndicate-refined from bought Deuterium."

## 10. Levers to tune (enumerated, not yet valued)

- Route allocation multiplier (1.1×) and the reference price used to size the credit grant
- The reserve-based price curve (already exists in the spreadsheet)
- The Deuterium→fuel **conversion rate**; whether the Syndicate **auto-refines** all it buys or holds raw stock; the **price/standing** a guild earns selling raw Deuterium; the **black-market refining fine** (§7). *(The retired licence-fee / discount-curve levers no longer apply — design.md #55.)*
- The bare-licence premium (= the price of hoarding)
- Quota window length (24h is a placeholder)
- Grace/ramp on legitimate production dips
- **Subsidy strength** (the factionalism dial / third galaxy-character axis)

## 11. Still open — decide on purpose

1. **1.1× vs 1.0×** — confirm the 10% route gain is an intended logistics subsidy.
2. **Marketplace coverage** — does the fuel benefit extend to guild↔guild trades routed through the Syndicate marketplace, or only direct Syndicate/Guild trades? (Leaning: latter.)
3. **Quota-window fairness** — 24h interacts hard with tick rate and async play; a guild that can't log in daily gets punished. Same shape as the vote-window fairness problem (#14).
4. **Legitimate-dip grace** — *moot for fuel under the monopoly*: there is no guild fuel refinery to knock offline and no discount to lose. The analogous concern survives only for the general venture-licence quota (design.md §5), not here.
5. **Geography-as-destiny** — watch that good starting neighbours don't become a dominant opening once there's real play.
6. **Detecting a secret reserve.** Legal fuel hoards are visible (they are *purchased*); an illegal black-market refinery hides its output. Detection rides the volume signal (§6) — fuel moved that a guild's legal purchases can't account for — rather than the retired hoard-valuation-via-licensing trick.
