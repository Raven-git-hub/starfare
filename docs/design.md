# Galactic Economy Game — Consolidated Project State

Last consolidated 19-07-26 *(adds: the fuel allocation & production model — pooled purchasing-power allocation, per-burn need-responsiveness, the Syndicate-only fuel benefit and its regional-bloc tension, and conditional refinery licensing that retires the old anti-hoarding list; force-sell flagged as a Phase 1 decision (§8, full model in `docs/fuel-allocation-model.md`). Previously (17-07-26): concurrency & scaling under real load (§15.7), repo reconciliation & corrected implementation statuses, the Syndicate Exchange & Tier‑4 asset commissioning merged from the Marketplace thread, the fuel simulator's exact port semantics, the eight-step tick order, the widened Phase 1 scope, and extraction of the checklist-level roadmap to `docs/roadmap.md`. Previously: planet archetypes & resource-node generation, galactic rare-tier gradient, starter-system tagging & validation, the System & Planet Index UI, Toll Gates & Toll Paths, Syndicate transport terms, onboarding, data architecture, seed generation, roadmap, AI-assisted development practice)*

*This is the living master document and the contract all code is built against. When code and this document disagree, that's a bug in one of them — fix it and keep them in sync, in the same commit. Live status and per-phase checklists are deliberately **not** here: they live in `docs/roadmap.md`, the only other authoritative document. On status, roadmap.md wins; on design, this document wins.*

*A hard lesson from the 16-07 repo reconciliation is now policy: **no artifact leaves a session unsaved.** An earlier session's generator work (archetypes, resource nodes, starter tagging, validation) was documented as implemented but the code was never committed anywhere and is lost. Statuses below have been corrected accordingly.*

## 1. The Vision

The project is a real-time, persistent, self-hostable web game. Each player runs a **Guild**, competing and cooperating across a shared galactic economy. The defining tension is **mutual dependency without trust**: every guild needs the same scarce resources and shared infrastructure, and no single entity can be allowed to fully control them without threatening the whole system.

One institution sits above individual guilds: **The Syndicate** — the overarching, somewhat mysterious collective that every guild holds a stake in, and the galaxy's shared political, legal, and market governance layer. (It takes over from the earlier CHOAM concept, and absorbs the separate Fuel Company that earlier drafts split this role with; there is now one institution, not three.) The universal stake is what makes it more than a background authority: no guild sits outside it, every guild is part-owner of the thing that governs them all, and its opacity is deliberate — guilds work out what the Syndicate wants by watching what it does. The Syndicate has three main functions:

- **Administering the fuel utility** — it controls the flow of Deuterium, the only viable fuel in the galaxy, from reserve to allocation (Sections 3 and 8).
- **Issuing Venture Licences** that permit guilds to perform economic functions like mining, processing, and manufacturing (Sections 2 and 5).
- **Administering the galaxy's public market and exchange** — the Syndicate Exchange — where guilds trade the goods they need or manufacture. This includes on-demand production as an anti-stall fallback (Section 4) and a public goods transport system for guilds that lack their own transportation (Section 6).

A design philosophy has emerged across every system designed so far, and it's worth stating explicitly because it now functions as the project's constitution:

- **Pressure over prohibition.** The game almost never says "you can't." It says "you can, and here's what it costs." Blockades can be ignored, fines can be treated as a cost of doing business, neutral institutions can be captured by coalitions — all deliberately.
- **New drama routes through existing systems.** Events, disasters, missions, and disputes all resolve through the mechanics already on the table (council votes, tolls, market pricing) rather than spawning bespoke minigames.
- **The bigger they are, the harder they fall — structurally, not by rule.** No progressive-taxation mechanic punishes the leader. Instead, scale creates surface area: more territory, routes, ventures, and fuel draw all mean more exposure. Leaders aren't taxed; they're targets.
- **Soft costs, felt pressure, decaying advantages.** Precedents decay, leases expire, disposition drifts toward neutral, baselines shrink in relative terms. Early capture never becomes permanent constitutional law.

A fifth principle has emerged from the technical work and belongs alongside the others, because it now governs the data model as much as the fiction:

- **Derive, don't store.** Anything computable from something smaller isn't authored — the hex lattice, a bare hex's ownership, a guild's list of territories. This is the engineering face of "single source of truth," and it's what keeps a ~101,000-hex galaxy small and fast (Section 15).

---

## 2. The Galaxy: Planets, Territory, and Routes

### Planets

Planets are the ultimate source of all raw materials and were designed as both a gameplay surface and a visual one. Each planet is **procedurally generated** and assigned one of nine **archetypes** (below), which determines both its character and which resources it can carry. The original "mono-biome vs. multi-biome" framing survives as intent rather than as a separate stat: **diversity correlates with resource variety and opportunity**, but it's now expressed *through* the archetype — Terran is the diverse, many-resource world; Desert is deliberately sparse; the rare tiers are narrow and specialised. Archetype is a legible at-a-glance signal of economic value, which is exactly what biome diversity was for.

Each planet has a **finite number of resource nodes** (1–15, set by archetype rather than by size), creating a secondary land-rush nested inside territory control: owning a planet doesn't automatically mean controlling its yield, because guilds still race or negotiate to fill or lease its nodes. Lease terms should **expire or require renewal** rather than granting permanent claims, echoing the precedent-decay principle used elsewhere.

*(Note: this range supersedes the earlier "roughly 5–20, scaling with biome diversity and size" figure, which predated the archetype design. Most archetypes now sit at 2–6; Terran alone reaches 15.)*

*(Status: **designed; not currently implemented in the repo.** A 15-07 session reported this implemented and verified, but the generator and seed actually in the repo predate that work — planets are bare `{id}` placeholders — and the implementing code was never saved (see §16's corrected tooling list). The design below stands as the spec for re-implementation: roadmap **Track G**. `Planet.stats` — atmosphere, size, climate, explicit biomes — was unbuilt even in the reported version; archetype carries the whole economic load, and it's enough for the economy.)*

There are two licensing paths for placing a mining or processing operation: apply for a **Syndicate Venture Licence** for mining (the clean, legal route); or **operate without a licence** (faster, but exposed to being reported and fined via the existing legality-vote system if/when caught). A guild may **lease a node from another guild** for a fee, but still requires a Syndicate licence. A distinction worth preserving in the fine system: an outsider squatting on someone else's planet (trespass-like) versus an owner skipping the licence on their own land (regulatory/tax-evasion-like) — same council-vote resolution, potentially different fine defaults and precedent categories.

**Disasters are dynamic and storyteller-driven**, not baked into a planet's generated stats — so risk can't be priced in and min-maxed around. A planet's atmospheric/surface profile biases the disaster's _flavor_ (volcanic worlds erupt, storm-heavy worlds get route-disrupting weather), while the storyteller decides _whether and when_. Disasters plug into the same surface-area targeting logic as everything else, resolve through existing systems (venture downtime, council relief votes, market shocks), and follow the same ~70/30 telegraphed-vs-sudden split as other storyteller events.

### Planet Archetypes & Resources

Nine archetypes, each with a relative frequency weight, a node-count range, and a fixed resource pool. **Archetype constrains which resources can appear** — the recommendation from the old open question #29, now adopted: it makes the galaxy feel authored rather than uniform noise, keeps diversity-as-value-signal honest, and gives a direct lever on scarcity at generation time.

| Archetype | Weight | Nodes | Resources |
|---|---|---|---|
| Rocky | 28 | 3–6 | Titanium, Copper, Lead, Silica |
| Oceanic | 14 | 3–5 | **Deuterium (≥2 guaranteed)**, Carbon Products, Polymers |
| Ice | 14 | 3–5 | Ammonia, Nitrogen, Helium |
| Desert/Arid | 14 | 2–3 | Titanium, Silica (sparse) |
| Terran | 8 | **15** (guaranteed minimums + random fill) | Titanium ×2, Copper, Lead, Silica, Lithium, Polymers, Carbon Products, Nitrogen, Gold, Silver, Tungsten — each guaranteed at least once, +3 more drawn randomly from the same pool |
| Gas Giant | 8 | 2–4 | Xenon, Helium, Nitrogen |
| Molten | 8 | 2–4 | Gold, Silver, Tungsten |
| Irradiated/Exotic | 4 | 1–3 | Neodymium, Palladium |
| Crystalline | 2 | 1–3 | Silica, Neodymium |

Weights sum to 100 (relative frequency, not a literal percentage — still subject to the placement RNG like everything else). **Cap: 10 nodes on any randomly-drawn planet**, enforced as a startup assertion against every archetype's range rather than a comment. Terran is the sole named exception, listed explicitly rather than silently exempted.

Two archetypes guarantee a baseline that random draws can't be trusted to hit:

- **Terran is the homeworld archetype**, and its guarantee is a fairness feature: every new guild starts on a Terran planet (Section 13), and no guild should start *below* a fixed baseline of access. The 3 random extras mean individual Terran worlds still differ slightly from one another. Terran's guarantee deliberately includes **Gold, Silver, and Tungsten** — metals fundamental enough that "you can find gold on Earth" is the right instinct. The knock-on is worth naming: those three are Molten's *entire* pool, so this blunts the rare-tier gradient (below) for exactly those metals. Molten still matters for **scaling beyond** a homeworld's 1–3 nodes each at production volume; it no longer gates basic access. That's the accepted trade.
- **Oceanic guarantees ≥2 Deuterium nodes.** Oceanic *is* Section 3's "sea world" — the sole fuel source in the galaxy. Fuel is a hard galaxy-wide dependency, not flavour, so it isn't left to chance the way a Molten world's Gold yield is. This makes Oceanic frequency (14) the single most consequential number in galaxy generation: it sets total fuel supply. It's deliberately held at "common" — concentrating the one resource every guild needs would hand whoever holds that region a chokehold the Syndicate's whole anti-monopoly design exists to prevent.

### The Galactic Rare-Tier Gradient

Archetype assignment is otherwise **spatially blind** — an independent weighted draw per planet, with no awareness of its system or neighbours. There are no volcanic belts or ice nebulae; it's closer to shaking a bag of weighted tokens over every planet slot than to authoring regions. One deliberate exception:

The galaxy is split into three concentric rings by distance from the Citadel (0–⅓ radius = inner, ⅓–⅔ = middle, ⅔–1 = outer), and the three **rare-tier** archetypes — Molten, Irradiated, Crystalline — get a per-ring weight multiplier on top of their base weight: **inner ×4, middle ×1, outer ×0.25**. Measured on a real seed in the unrecovered 15-07 build, that produced ~41% rare-tier planets in the inner ring against ~3.6% in the outer — an ~11× spread. Treat those figures as verification targets for the Track G re-implementation, not as facts about the current repo.

The multiplier has to be that aggressive because equal *radial* thirds are not equal *area* thirds: area scales with r², so the rings run roughly 1 : 3 : 5 by area. A gentle inner bump would be swamped by the outer ring's sheer size.

**Fuel and the common tier are exempt from any gradient**, for the reason given above. Rare-tier goods are advanced-manufacturing and luxury inputs, not survival resources, so clustering them coreward is safe — and it's the scientifically grounded direction: the heaviest elements (gold, platinum-group metals, rare earths like neodymium) come mostly from neutron-star mergers, whose enrichment concentrates toward the galactic core over cosmic time. "The deep core is where the good stuff is, and it's dangerous, contested territory" is free narrative that plays directly into the territorial-conflict theme.

The gradient creates real regional contention without making anything strictly unreachable: **every starter system is guaranteed ≥2 rare-tier planets within ⅓ of the galaxy's radius**, enforced by a repair pass after generation (Section 16). The guarantee is deliberately *not* comfortable — ⅓ radius is a long haul and 2 planets is a floor, not a target. The intent is friction and contested access, consistent with pressure-over-prohibition: not impossible, just expensive.

*(Note: an alternative "uniform spread / every resource within a comfortable radius" rule was considered and rejected — it fights the game's own design. Extraction is territorial, supply chains are an attack surface, scarcity is meant to bite. A galaxy where nothing is ever far away is a weaker version of the premise, not a fairer one.)*

### Territory and Routes

Players control **territory**, which changes hands through conflict, negotiation, or economic pressure. Territory owners establish **shipping routes** through their land; the number of routes scales with **influence**. Other guilds can use these routes for a **toll** set by the owner — with the natural tension that too high drives traffic away or invites defiance, too low leaves value on the table. Tolls are **bilaterally negotiable**: guilds can trade influence, mining rights, or discounts instead of accepting posted rates. Route **quality and security** are tied to ownership — well-patrolled territory offers faster and safer transit than contested space, giving owners a second lever beyond tolls. By default, toll routes are exponentially safer and faster than going through uncontrolled space to encourage players to use and build tolls when possible.

Territories may also contain resources other guilds need, and owners can set **extraction and processing fees**, negotiable like tolls. Combined with the later ventures-decoupling decision (Section 4), territory owners now hold **three distinct economic levers**: tolls on transiting shipments, tariffs on resource extraction/processing, and land lease/rent for tenants who install fixed ventures on their land.

### Toll Gates & Toll Paths

The "toll routes are exponentially safer and faster" principle above now has a concrete deployable structure behind it. A **Toll Gate** is a single-hex, guild-controlled claim in the same family as an Outpost, but purpose-built for the toll mechanic rather than as a relay hub.

- **What it does.** A Toll Gate anchors one end of a **Toll Path** — a guild-controlled, actively-monitored corridor between two of that guild's own gates. A transport using it gets a vastly reduced piracy chance and a speed buff (narratively: the corridor is watched for obstacles and threats, an early-warning system), and in exchange the controlling guild charges a toll. The intent is to make tolls genuinely **attractive to use**, not merely tolerated — a fertile, ongoing economic battleground rather than a tax players route around on principle.
- **The Syndicate controls no tolls.** Toll Gates are exclusively a guild tool, consistent with the Syndicate's role as governance and utility rather than a competing economic actor.
- **Placement.** A Toll Gate anchors within a maximum hex range (10, in current test tooling) of *either* a system **or** an outpost belonging to the same guild. An Outpost itself only ever anchors to a system — never to another outpost — so this is the one extra hop that lets a guild's infrastructure reach further than a single outpost radius allows: `system → gate (≤10) → outpost (≤10) → gate (≤10)`, i.e. roughly 20 hexes of protected reach from a system before a guild must fall back on open, unprotected transit. Narratively, outposts aren't self-sustaining and need resupply from a system — the *reason* (not a separate hard mechanic) the chain has to terminate rather than run indefinitely. This also gives the previously-deferred "outposts extend claim/reach, with no production function" rule (Section 4) its first real purpose.
- **A Toll Path is always gate-to-gate, full stop.** A transport may only enter or exit at a gate, never mid-path. An **outpost is never a path endpoint**. It becomes a de facto "hub" only because several of a guild's independently-anchored gates can cluster near the same outpost, letting multiple separate gate-to-gate paths funnel through roughly the same point — e.g. a ring of border systems each feeding a gate near one central outpost, which in turn feeds a single long path back to the guild's main base. That's geography, not a new relationship type.
- **Path length itself is unbounded.** The 10/20-hex rule governs where a gate or outpost may be *placed*, not how long the corridor between two already-placed gates may run. The long haul from a frontier hub back to a main base is one path, no intermediate anchor required.
- **Nothing forces a guild onto the toll network.** A transport can always just fly open space. The cost of doing so is ordinary piracy exposure and ordinary (slower) speed — which is exactly what makes the toll worth paying rather than a tax to be endured.
- **Visual convention.** On the map, a Toll Gate uses the same single-hex marker as an Outpost — deliberately identical, so the map stays legible at a glance. The only distinguishing marks are the claimed hex itself (a bold, guild-coloured, largely unfilled "hollow ring" border — a stargate-like read — rather than the normal solid-filled territory tint) and the `Type` field in its info panel. A Toll Path renders as a guild-coloured dashed line between its two gates.

Toll Paths also turn out to be the single most technically valuable structure in the game — see Section 15's tick loop, where the gate-only-entry rule collapses interruption checking from per-hex to a single roll.

---

## 3. The Economy: Resources and the Manufacturing Tree

Everything buildable traces back to raw materials mined from planets, through a **four-phase pipeline**: Raw Materials → Processed Materials → Manufactured Parts → Constructed Items / Advanced Assets. The one exception is **Deuterium**, which runs on a parallel track as the game's sole energy source — consumed to _run_ ventures and fleets rather than climbing the parts ladder. Deuterium is a fusion fuel found only on **sea worlds** — concretely, the **Oceanic** archetype (Section 2), where every planet is guaranteed ≥2 Deuterium nodes and Oceanic frequency is therefore the galaxy's fuel-supply dial. This makes Oceanic the *Arrakis* of the setting: one archetype, needed by every guild, controllable by none — the core premise made literal in the generator rather than only in the fiction. Processed Deuterium Fuel is the one commodity that is **Syndicate-regulated and cannot be sold privately**; guilds earn larger fuel allocations by contributing to deuterium reserves, giving the scarcity system a positive-sum lever alongside its baseline mechanics.

### Material Roles

Raw materials play three structurally different roles as they climb the tree, which matters because they create different kinds of bottleneck:

- **Embedded-component materials** physically persist into the final good — Titanium, Carbon Products, Lithium, Gold/Silver/Copper, Silica, Polymers, Tungsten, Lead, Neodymium.
- **Process-consumable materials** are consumed _during_ fabrication rather than becoming part of the output — Palladium as a refining catalyst; Xenon and Nitrogen as fabrication gases. A shortage here throttles _all_ downstream output depending on the process, a distinct chokepoint from a missing component.
- **Energy input** — Deuterium alone, sitting outside the tree entirely and tying into the energy-throttle mechanic.

### The Pipeline

**Raw materials:** Minerals — Titanium, Lithium, Polymers, Carbon Products, Gold, Silver, Silica, Copper, Lead, Tungsten, Palladium, Neodymium. Gases — Xenon, Ammonia, Nitrogen, Helium. Fuel — Deuterium.

**Phase 1 → 2 (Raw → Processed):**

|Raw Material|Processed Material|
|---|---|
|Titanium|Titanium Alloy Plate/Ingot|
|Carbon Products|Carbon Fiber Weave / Nanotube Cable|
|Lithium|Battery Cells|
|Gold / Silver / Copper|Conductive Wire/Contacts|
|Silica|Glass / Silicon Wafer|
|Polymers|Composite Resin|
|Tungsten|Heat-Resistant Alloy|
|Lead|Radiation Shielding Stock|
|Neodymium|Magnetic Assemblies|
|Ammonia|Coolant/Refrigerant Fluid|
|Palladium, Xenon, Nitrogen, Helium|Consumed as process inputs only|

**Phase 2 → 3 (Processed → Manufactured Parts):**

|Manufactured Part|Built From|
|---|---|
|Engine Components|Titanium Alloy + Heat-Resistant Alloy|
|Structural Frame Sections|Carbon Fiber Weave + Composite Resin|
|Power Storage Units|Battery Cells + Conductive Wire|
|Microchips / Sensors|Silicon Wafer + Conductive Wire (+ Xenon as fabrication gas)|
|Computers|Microchips + Power Storage Units|
|Reactor Core Housings|Radiation Shielding Stock + Heat-Resistant Alloy|
|Motors/Generators|Magnetic Assemblies + Conductive Wire|
|Life Support Machines|Composite Resin + Power Storage Units + Coolant Fluid|

**Phase 3 → 4** began as a generic constructed-items table (Space Vehicles, Refinery/Factory Modules, Weapons, Stations/Colony Modules) establishing the key principle that most constructed items draw on **multiple independent supply chains simultaneously** — so cornering a single material can stall production several tiers up without ever touching the target directly. The advanced-manufacturing pass has since started replacing that table with specific asset recipes (Section 4). The whole tree remains a starting shape rather than a locked recipe list.

---

## 4. Advanced Manufacturing: Assets, Drones, and Ships

This is the most recent major design pass, covering the end-tier of the tree — usable assets built from manufactured parts.

### Asset Categories and Market Scope

Assets fall into two functional categories governed by different existing systems. **Consumable/deployable assets** (transport ships, weapons, security drones) get used, committed, or destroyed, and route through the market. **Infrastructure assets** (station modules, factory/refinery modules, installed drone capacity) are persistent modifiers on a site or territory, and route through the venture/territory system.

A significant decision: **every commodity is tradable on the Syndicate Market**, up to and including an entire factory complex. This makes **capital itself a viable path to power**, distinct from territory, production efficiency, or influence — a purely financial guild could buy its way into an industrial base without winning a territorial fight. It also reframes build-vs-buy as a three-way choice (build it, buy the inputs, or buy the finished asset), and it clarifies what hostile takeovers are actually _for_: not acquiring generic capacity (buyable on the market) but acquiring a specific venture's established relationships, reputation, and territorial position.

### Syndicate On-Demand Production

If a commodity or asset is unavailable on the market because no player has produced it, a guild may commission it from the Syndicate instead, at a cost in credits and time. The Syndicate can produce any item but does not do so continuously — this exists purely to prevent players stalling when nothing is available, and is most likely to matter for advanced assets and ships. Pricing is **deliberately above market**, so it functions as an escape valve rather than a competitor to player manufacturers. The working idea is either a percentage markup on the good's current market price, or the calculated cost of all its components at current prices — mechanism and premium size undecided. (Worth noting the two mechanisms diverge in exactly the case this feature exists for: a never-produced good has no market price to mark up, while its components usually do — so the component-cost method may be needed at least as a fallback.)

### Ventures Decoupled from Territory

**Venture ownership and territory ownership are now independent.** A guild can lease space inside another guild's territory and bring its own factory and drone workforce. This creates the territory owner's third economic lever (land rent) and a new tenant vulnerability: lease-based pressure (denied renewal, hostile rent hikes), analogous to how routes are exposed to blockades. Whether lease disputes route through the legality/council system, and whether placed ventures are relocatable or fixed once built (which determines just how hostage-like the landlord relationship gets), are deferred to gameplay-level design.

### Space vs. Planet

A clean working rule was set: **space = claim/reach, planet = production.** Outposts are deployable in space purely to extend territory, with no production function; factory and refinery modules are planet-bound and are what drone complements staff. The outpost's "fuller purpose deferred" note is now partly answered — an outpost is the **mid-chain anchor that extends a guild's Toll Path reach from ~10 to ~20 hexes** (Section 2).

### Drones

A single drone type (no quality tiers for v1) deploys into one of two roles, reassignable with a time delay:

- **Factory role** staffs a venture's production. Ventures have a min/max drone complement; below minimum, the venture doesn't operate. Output scales from min to max on an **exponential curve** — concentration is heavily rewarded, with a hard cap at max.
- **Security role** staffs route/territory defense, scaling **linearly** — deliberately weaker than the factory curve so over-investing in security never dominates.

The asymmetry between those two curves produces a deliberate emergent effect: near-max factories are structurally high-value, disproportionately under-defended targets, since defense spend can't linearly keep pace with exponential output growth. This reinforces the storyteller's "bigger target" logic organically, with no extra rule.

Drones decay only while deployed (never idle in storage), with decay slowed by a flat-credit **maintenance spend** — keeping it in the same mechanical bucket as other venture dials. Combat losses are a separate, rarer layer on top of routine decay. It is yet to be decided if drone states are tracked individually, or by pool. Idle stockpiles incur storage costs scaling with size, consistent with the fuel model, with the storyteller as a rare dramatic backstop against extreme hoarding (factory recalls, drones gaining sentience). Complement size and condition are **hidden by default**, inferable only through the future espionage system.

The recipe uses only existing Phase 3 parts — Motors/Generators (mobility), Computers (autonomy), Microchips/Sensors (perception), Power Storage Units (power), Structural Frame Sections (chassis). Notably there is no weapon component (security is an assignment, not a build variant) and no Life Support (drones are non-organic).

### Ships

**All spaceships run on Deuterium reactors** as standard equipment across every class. Two transport classes are drafted:

- **Light Transport:** Structural Frames (hull), Reactor Core Housing (primary power), Power Storage Units (buffer/backup), Engine Components (propulsion), Motors/Generators (maneuvering), Computers (navigation), Life Support (crew). No sensors, no weapons.
- **Medium Transport:** the same skeleton with doubled-tier frames, power storage, and life support — plus **Microchips/Sensors as a new component type at this tier** (collision avoidance, route scanning, threat detection).

The design intent behind the medium draft matters more than the numbers: ship tiers differentiate by **gaining new component types, not just scaled quantities**, so tiers feel qualitatively distinct. Sensors and weapons are emerging as separate, independently unlockable capabilities. The reactor/battery split also quietly sets up a possible future "graceful degradation" combat mechanic (reactor damaged → ship limps on battery reserve) — noted, not designed.

Not yet covered: heavier ship classes, weapons recipes, station module recipes, and Power Storage Units' full cross-asset role definition.

---

## 5. Ventures, the Market, and Supply-Chain Warfare

Guilds set up **ventures** — small production companies for mining, refining/processing, and manufacturing, operating under Syndicate Venture Licences (or unlicensed, at the legal risk described in Section 2). Goods sell into a shared market where scarcity commands better prices and abundance worse, with soft logistic floors/ceilings preventing runaway spirals. Guilds aren't required to sell to market: they can stockpile or consume internally, creating the **build-vs-buy** tension between vertical integration (secure, capital-intensive) and specialization (efficient, exposed).

Supply chains are an explicit **attack surface**: a guild can starve a rival's venture by cornering an input market or pressuring a supplier's territory owner — all without direct conflict or rule-breaking. **Partial transparency** supports this: venture _types_ are visible (letting rivals infer likely inputs), but exact stockpiles are hidden, preserving room for market intuition and the future espionage layer.

**Production is automated.** Players set parameters — production rate, buy/sell thresholds, stop conditions, stockpile targets — rather than micromanaging, so casual players can set conservative defaults while engaged players tune aggressively. Production scale is throttled by **energy consumption drawn from the same fuel pool as fleet operations**, which is the deliberate crux: during a shortage, a guild must choose whether to fuel the fleet or fuel the factories.

Other guilds can take **minority investment stakes** in ventures they don't own, giving smaller guilds a way into production without territory and owners a way to raise capital without losing control — and creating negotiation surfaces like "I'll invest if you guarantee priority access to output."

### Reputation and Hostile Takeovers

Ventures carry a **fully visible reputation score** serving double duty as an investment-risk signal and a **takeover trigger**: hostile takeover eligibility unlocks only when reputation drops below a threshold, protecting healthy ventures from casual predation, and **only shareholders vote** on a takeover, keeping it a private-capital matter rather than galaxy politics. Rivals can deliberately suppress a target's reputation — primarily through **legitimate market pressure** (outbidding suppliers, poaching shipping partners via better toll rates, trade refusal), with **actual sabotage** as an optional higher-risk layer carrying exposure risk and legality consequences. Because reputation is visible, targets can see pressure building and respond: shore up suppliers, contest routes, appeal to council, dilute ownership toward allies, or arrange poison-pill side-deals. A distinct **guild-level reputation** could track vulture-tactic patterns, making predatory guilds harder trading partners over time. What minority investors receive in a takeover (likely a payout at takeover price) still needs defining.

### The Syndicate Exchange *(merged from the Marketplace thread, 17-07-26)*

The shared market now has a concrete microstructure — a two-sided exchange:

- **The Syndicate as market-maker.** For Tier 1–3 goods it holds effectively inexhaustible stock and will always buy or sell at a single computed **value**, derived from total galactic supply. The real supply figure is hidden; players see only the value and its history. This generalizes the fuel utility's supply-derived pricing to ordinary goods — and the Phase 1 sandbox's "reuse the fuel curve's shape for the second good" proposal is exactly this line, in miniature.
- **The player order book.** Guilds list asks and bids at any price, sorted conventionally; the book sits alongside the Syndicate line and can diverge from it freely in either direction. The gap between the steady Syndicate line and the scatter of player trades is the "trust nobody, need everybody" premise made visible. Trading with the Syndicate is never strictly better or worse than trading with a guild **on price** — reliable and unglamorous beside noisier and potentially more profitable. Neutrality holds on *price* only: the Syndicate competes on **fuel access**, not rate — Syndicate-facing trade can earn a fuel-allocation benefit a peer trade does not (§8). That benefit rides a separate axis and doesn't make the Syndicate the better *deal*, so it refines this neutrality rather than breaking it. The book proper needs multiple actors, so it lands with Phase 3.
- **Fuel is never listed.** Syndicate-regulated, not privately tradable (Section 3) — the Exchange enforces that rule rather than being an exception to it.

**Tier‑4 assets trade on a fundamentally different model**, because the Syndicate stocks none of them — ships, drones, deployable mining rigs, factory complexes, Outpost and Toll Gate construction kits:

- The "Syndicate price" for an asset is a **component-cost estimate**, recomputed every tick as component prices move up the tree, and labeled on the chart as an estimate — never a guaranteed rate. (This is open question #26's component-cost method, adopted for the case where it's structurally necessary.)
- Buying from the Syndicate is **commissioning a build**, not a purchase: a build-time wait applies, the price locks in at **delivery** rather than at order — realized-on-arrival extended to construction — and everything the Syndicate builds arrives at guaranteed **100% condition**. The Syndicate never sells used.
- Selling an asset to the Syndicate is **permanent absorption** into its own fleet, at `salvage% = max(condition% − 5, 10%)` of the current commission price. The floor exists because there are always reusable parts; the absorption exists because without a sink, buy-new-and-instantly-resell is an infinite credit loop.
- The player book for assets is expected to run thin-to-empty, with an honest empty state pointing at the Commission panel. Asks carry a visible **condition%** column (bids don't — a buy offer has no condition until matched); condition itself stays hidden until inspected, per the partial-transparency principle. The "lemon" reframe follows: a heavily-maintained used asset can be a genuine bargain against a fresh commission, or a lemon — which it is depends entirely on the seller's upkeep record, and that uncertainty is the point.
- Salvage deliberately plugs into the **not-yet-designed condition/maintenance system** (Section 4's drone decay is its nearest relative): once that exists, condition feeds salvage directly, giving maintenance spend a second payoff beyond avoiding breakdown.

UX direction is settled — trading terminal, not storefront: warm near-black base, parchment ledger text, brass reserved exclusively for the Syndicate's reference price so it reads as "the one number that's true," verdigris bids / oxide asks, monospace for all numeric columns, tier-tab navigation, the price chart as the screen's signature element. The working mockup `SyndicateMarketplace.jsx` was built in that thread but never saved — see §16's missing-artifacts list. Open questions raised: #38–41.

---

## 6. Logistics: Travel Time, Vehicles, and Risk in Transit

Trade routes take **real time** — days or weeks of actual clock time across the galaxy — turning arbitrage into genuine risk/timing gameplay: will the price hold until arrival? Will the route stay safe? Could a vote change conditions mid-transit?

Vehicles (themselves manufactured goods, per Section 4) trade off speed, capacity, cost, and piracy vulnerability, with speed and capacity costing more in materials and energy. Route speed and safety are modified by territory ownership and quality. In-transit shipments are a **vulnerable state** exposed to interception, with **partial visibility**: territory owners see what crosses their land (they collect tolls anyway), while third parties must invest in intelligence. Contract shipping with risk-sharing/insurance is a likely v2 feature, and vehicle manufacturing is strategically important beyond self-use — guilds can specialize in building, selling, and leasing vehicles.

A rule that spans this whole section and hardens into an invariant in Section 15: **value is not realized until arrival.** Cargo in transit is in no market and worth nothing until it lands (or is fenced).

### Syndicate Public Transport

For guilds without their own fleet, the **Syndicate public goods transport system** will move shipments for a fee. It exists chiefly as an **early-game on-ramp**: new guilds won't yet have the means to get goods to market, and without it the entire trade loop would be gated behind ship acquisition. The terms are now settled:

- **It is a real Shipment, not an abstracted transaction.** The Syndicate dispatches an implicit **Syndicate Hauler** vehicle from its nearest outpost, and it is the same Shipment entity under the same rules as any player's. No bespoke transaction path, no parallel "how do goods move" code path.
- **Round trip, not one-way** — outpost → seller → outpost. Transit is therefore roughly **double** a normal one-way shipment. This doubling *is* the premium: the felt cost of not owning a ship, and the motivation to build one. (It replaces the earlier idea of a tuned credit premium as the main disincentive; the fee below is secondary.)
- **Price resolves at return**, on delivery back at the outpost — not at dispatch or pickup. Same realized-on-arrival rule as any shipment. The market can move for or against the seller during the round trip. This is an intentional seam of risk, not a rough edge to smooth over: a savvy player can time sales toward a favourable window, and a rival could bait one into a badly-timed haul.
- **Fee**: a flat percentage skim off sale proceeds at the price realized on return — `credits = quantity × price × (1 − feePercent)`. The fee is a credit sink and must go somewhere real (to the Syndicate as an institution), not simply vanish — see the credit-conservation invariant in Section 15.
- **Scope is deliberately narrow.** The Syndicate moves *only goods being sold to it*. It will not ferry a settlement, an outpost, a drone complement, or any asset a guild intends to deploy elsewhere — otherwise it silently dissolves the vehicle-gated expansion goal that anchors onboarding (Section 13).
- **The fleet is unlimited and elastic.** No queuing, no contention, no "the Syndicate ship is busy." It's a utility, not a competing economic actor; only geometry (distance to nearest Syndicate outpost) determines wait time. A deliberate simplification.
- **It pays no tolls and is exposed to piracy like anything else.** Syndicate shipments are interceptable **exactly like any other shipment** — no blanket immunity. The Syndicate Hauler simply carries a very high defense rating, making a successful hit rare rather than impossible. Because a hit requires a deliberate target choice, it is **attributable human piracy** under the existing rule (Section 10) and carries the usual legality consequences — unlike ambient bot piracy. This keeps "use the safe default" a real, if small, risk decision, consistent with the game's core theme.

The service is naturally outgrown rather than deliberately deprecated: as soon as a guild fields its own transports (or later contracts a player shipper), the round-trip time penalty makes doing so obviously better.

---

## 7. Politics and Law: The Council, Legality, and Fines

Recurring **council sessions** let players vote — weighted by Syndicate shares/influence earned through gameplay, making influence itself contested — on tariffs, quotas, dispute rulings, and fine schedules. Votes are designed to be **zero-sum or resource-constrained**, forcing real trade-offs and coalition-building; vote trading, side deals, and strategic abstention are core to the experience. Votes resolve in **real time windows** (e.g. "open for the next 6 hours").

The legality system embodies the pressure-over-prohibition philosophy. Territory owners can refuse access or deny rights; other guilds can simply **ignore** the refusal and act anyway. Whether the action was legal is decided by **council vote** — currently leaning toward _everyone_ voting, including interested parties, which is messier but thematically honest about power writing its own rules. Rulings can impose **fines** or **forced compliance** (ongoing access at a council-set rate), and can optionally set **precedent** that weights future similar votes but **decays over time** so early-server capture can't ossify. **Ruling scope is deliberately limited** — outcomes sting but can't destroy a guild outright, though a proposed **pile-on guard** (dispute cooldowns or escalating case costs against the same target) is needed to keep "small scale" true in aggregate, not just per-vote.

**Fine levels are legislated by player vote** via a recurring penal-code session. Guilds treating low fines as a cost of doing business — and powerful guilds voting fines down for actions that benefit them — are intentional features mirroring real corporate behavior. Counterweights include fines that **compound with repeat offenses** (eventually triggering route revocation, forced share transfers, sanctions eligibility), fines **paid directly to the victim** as compensation, smaller guilds **pooling influence**, and a **unilateral retaliation option** (e.g. counter-blockade) available without a vote, at the risk of being fined in turn.

---

## 8. Fuel: The Syndicate Utility

Fuel is managed by the **Syndicate's fuel utility**, in which guilds buy stakes and bid for refining contracts but which no guild can control outright. Governance is hybrid: **ownership stakes** confer profit share and high-level policy votes (production targets, price bands), while **day-to-day operations** are awarded through a separate contract/bidding system, so stake alone never guarantees operational control. Ownership caps (~20–25% per guild) prevent single-guild dominance, but **coalition capture is deliberately allowed as an emergent risk** — echoing how neutral institutions get captured in reality, and giving the Syndicate real dramatic stakes. Note that with the old CHOAM/Fuel Company split now merged into one institution, coalition capture means capturing the _entire_ governance layer at once — considerably higher stakes than capturing a fuel utility alone, and it raises the question of whether fuel-utility stakes and council shares/influence (Section 7) are one instrument or two separate tracks inside the Syndicate (open question #28).

Scarcity is hybrid-sourced: **extraction is territorial** (tying into land control) and **refining is contract-based** (a distinct competitive layer). Distribution works through purchasing power rather than rationing: every guild receives a **flat baseline allocation expressed as purchasing power** (e.g. "$100"), so when scarcity drives prices up, the same baseline buys less fuel automatically — scarcity is felt by everyone without manual rationing. Refining contributors get **priority claims on surplus**. The baseline is fixed in nominal terms, so its relative value shrinks as the economy grows — a natural difficulty curve from a safer early game to a market-dependent late game. Pricing is a hybrid of an **algorithmic supply/demand base price** and **council-influenced emergency intervention** (price caps, subsidies, rationing during crises, at political cost).

Supporting mechanics under consideration: **shortage consequences beyond price** (reduced fleet capacity, lost route access, reduced influence generation) so scarcity stays existential; and a **survival floor** below which a guild _degrades rather than dies_, so a successful fuel squeeze can't crash weaker guilds entirely out of the game. *(The earlier anti-hoarding shopping list — decay/spoilage, storage costs, use-it-or-lose-it expiry — is **retired**: hoarding is now disincentivised structurally by the refinery-licence premium in "Allocation, the Pool, and Refinery Licensing" below. Re-adding spoilage on top would double-charge it.)*

### Allocation, the Pool, and Refinery Licensing

*Full treatment: `docs/fuel-allocation-model.md`. This is the summary; that file is the source of truth for the detail and its own open questions.*

Fuel differs from every other good in one structural way: the Syndicate has **no infinite backend** for it — it can't on-demand-produce fuel the way it backstops other goods (§4). So the **allocatable pool is exactly the surplus that net-producers deposit**, and route allocation draws from it. Source and sink are one balance sheet; conservation (invariant 1) is what forces them to sum.

- **Allocation is purchasing power, not a fuel quantity.** A guild shipping resources to a Syndicate outpost under licence receives **credits sized to buy ~1.1× that route's fuel burn** at a reference price. The reserve-based price (open question #2's curve) floats on the pool level, so when the pool drains, that fixed grant simply buys less — scarcity is rationed by affordability, per-guild and automatically, with no central multiplier-cutting. Sizing to actual burn makes allocation **need-responsive for free** (Dracis draws more than Ilyra) — the standing answer to the need-blind problem the earlier committed-capital model couldn't solve.
- **The benefit is Syndicate-facing only.** Peer-to-peer trades earn no fuel allocation (whether marketplace-routed peer trades count is open — #50). This deliberate logistics subsidy pulls traffic to the shared hub and quells factionalism; its strength is a self-hoster dial for how much regional fragmentation a galaxy tolerates. The counter-pull is geographic: a tight cluster of neighbours can rationally trade among themselves and eat the lost allocation — but a bloc that opts out of the perk also opts out of the **fuel-spike protection** it buys, leaving it structurally more exposed to a squeeze. The offer and its punishment are the same system at two different times.
- **Producers are paid in credits and standing, not more fuel** (a fuel reward to a fuel-maker is circular). Their reward is a **discounted, conditional refinery licence**: pledge a share of output to the pool for a discount; miss the quota window and pay the full fee — an ongoing commitment device, not a capacity grant that would snowball production toward one guild. The non-linearity is deliberate and load-bearing: **the pledge % required for a given discount rises with production volume**, so the bigger a guild's fuel operation, the more of it it must commit to keep the break — hoarding gets *vastly* harder as you grow. **Bare (unpledged) licences are priced prohibitively**, and the gap between the bare fee and the discounted fee **is** the price of hoarding — the licence-cost form of the retired spoilage mechanic (pressure, not prohibition: a 100% hoarder isn't blocked, just charged).

**Dependency — force-sell must be dropped.** This whole model presumes guilds *can* hoard fuel (the licence premium only bites if hoarding is possible). The current Phase 1 port contract bakes in **force-sell** (production goes straight to the pool — see the semantics below), which forbids hoarding outright. So force-sell has to go for this model to exist — a Phase 1 decision-checklist item and open question #48. Enforcement of *illegal* withholding is a Phase 5 council matter; until then hoarding is simply *possible and expensive*, which is exactly what the licence premium delivers without needing courts.

### What the Fuel Simulation Actually Showed

The fuel market has now been hand-simulated in a spreadsheet (`fuel_market_simulator.xlsx`) with five hand-played guilds — a Refiner, Stockpiler, Trader, Manufacturer, and a small guild — using a reserve-based price curve as a working proxy for the undefined formula (open question #2), and a flat $100/turn baseline allocation exactly as described above.

The headline result is that **the design works as intended**: a deliberate squeeze by the Stockpiler drains reserves, drives price from ~$5 toward the ceiling, and puts the Manufacturer into genuine unmet-demand shortfall because its fixed baseline simply can't buy enough at spike prices. The Stockpiler then dumps its hoard into the spike and profits twice. Scarcity was felt automatically, with no rationing mechanic — confirming the purchasing-power distribution model.

It also surfaced a real, unresolved balance problem that the design documents had not anticipated (now open question #31): **the squeeze enriched an uninvolved bystander more than it enriched the schemer.** The Refiner, simply producing steadily into inflated prices, finished richer than the Stockpiler who engineered the whole event. Whether that's a feature (production should be rewarded; the schemer takes the risk and the Refiner takes the windfall) or a problem (the target suffers, a bystander wins, and the plotter underperforms) is a genuine open design decision — and precisely the kind of second-order consequence only visible by playing the system rather than reading it. A sharper detail from the cell-level extraction: the Stockpiler finished **fourth of five** in credits — even Dracis, the intended victim, ended with more cash (867 vs 849), and Ilyra, who did nothing, ended with 1,298.

### The Simulator's Exact Semantics (the port contract)

Extracted formula-by-formula on 16-07-26. This subsection is the authoritative transcription; if the spreadsheet and this text ever disagree, the spreadsheet wins and this text gets fixed.

**The price formula** (the working proxy for open question #2):

```
price = clamp( basePrice × (targetReserve / max(1, stockpileStart)) ^ sensitivity,  floor,  ceiling )
```

Levers: base price $5 · target reserve 30 · sensitivity 0.6 · floor $2 · ceiling $40 · income $100/guild/turn · starting stockpile 30. Roster: Refinery Combine (Refiner — need 8, capacity 40, $120), Vantar Trust (Stockpiler — 5, 6, $250), Orun Compact (Trader — 4, 4, $120), Dracis Concern (Manufacturer — 12, 8, $100), Ilyra Holdings (Small guild — 3, 3, $60); all starting hoards 0.

**Five semantics the formula alone doesn't capture**, each binding on any port:

1. **Posted price.** The price for turn *t* is computed from the **start-of-turn** stockpile, and *all* of that turn's activity — buys, hoard sales, and production revenue — executes at it. Mapped onto §15.6: the price recompute (step 3) publishes the **posted price governing the next action window**; a tick's trades execute at the price computed the tick before. This reproduces the spreadsheet exactly (turn 1 opens at f(30) = $5). *(Proposed as the port rule; needs final sign-off — open question #42.)*
2. **Production is force-sold.** "Produce" puts fuel straight into the market pool and pays the producer at the posted price; even the Refiner buys back its own 8/turn need. This is the "fuel cannot be sold privately" rule (Section 3) already embodied — the reserve is fuel's only counterparty. *(Now pending a ruling — the allocation model above requires hoarding to be possible, which means force-sell must be dropped. Open question #48 and a Phase 1 decision-checklist item; if dropped, this semantic and the squeeze signature below are re-derived without forced sale.)*
3. **Consumption draws from a guild's own fuel** (prior hoard + this turn's buys), never from the reserve directly. Where it can't be met, the hoard **floors at zero and a shortfall is recorded** — the pattern invariant 3 cites. A hoard *sale* exceeding the hoard would be silently folded into shortfall by the sheet; a port should instead **fail** that action (treated as a sheet quirk, not intent).
4. **Over-demand is only flagged, never resolved** — the "OVER" cell is an honor-system instruction to the human to reduce a Buy. A port needs a real allocation rule; the proposal is §15.6's validate-as-they-arrive, whole order fails if the reserve is short, with a fixed deterministic order for "simultaneous" bot orders (an acknowledged fairness bias — open question #44).
5. **Credits are fractional in the sheet** (the Refiner ends at $3,230.741…), which violates §15.2's integer-credits convention. A port must round each transaction — proposal: `round(qty × price)`, the identical amount debited and credited so conservation holds (open question #43) — and therefore the squeeze regression check asserts the **signature results**, never byte-equality with the sheet's cells. Prices themselves stay real numbers (§15.2 constrains credits and goods, not prices; recomputed fresh from an integer reserve each tick, so no drift accumulates).

**The squeeze signature** (what any correct port must reproduce): price $5 (T1–4) → 7.03 → 16.75 → **38.48 peak at T7** — the $40 ceiling never actually binds — → 16.75 → ~5.10 (T9–12); Dracis shortfalls 6 / 7 / 2 on T6–8, plus Ilyra clipped for 1 on T7; final credits Refiner ≈ 3,231 vs Vantar ≈ 849 (Vantar also holding 13 fuel, which doesn't close the gap at recovered prices).

---

## 9. The Storyteller

What began as a random-events list evolved into a **Rimworld-style storyteller/director**: a system that reads galaxy state and _selects_ events to shape the dramatic curve. It monitors signals like market concentration, wealth/influence distribution (a Gini-style measure), time since any guild suffered a meaningful loss, and regional stagnation — making it the game's primary **anti-snowball force, delivered diegetically**. "Rebellion breaks out in the largest guild's overextended territory" reads as fiction even though it's functionally rubber-banding.

Its core targeting principle is **scale creates surface area**: more territory means more places unrest can spark, more routes means more piracy exposure, more ventures means more machinery to malfunction, more fuel draw means shortages bite first and hardest. The leader isn't taxed by rule — they're the biggest target in a hostile universe. Small guilds fly beneath the storyteller's notice, making "deliberately lean" a viable strategic identity — and this is also, with no new mechanism required, what protects a brand-new guild sitting in its reserved starter system (Section 13). **Bot disposition feeds targeting weights**: guilds that have made enemies of the bot factions become fertile ground for targeted events, while well-liked guilds may receive advance warnings — how you treat the little houses determines whether the universe conspires with or against you, with no new subsystem required.

The storyteller is a **director, not an author**: it picks when and where pressure lands, and the pressure resolves through existing systems (council funding votes, toll rerouting, the normal pricing formula). Events should **redistribute opportunity, not just delete value** — a black hole on a busy route ruins one toll empire and mints a new chokepoint baron overnight, keeping the ladder climbable. Event categories span supply-side shocks, route/territory shocks, political shocks, and fuel shocks, with a ~70/30 lean toward **telegraphed over sudden** events (and advance warnings themselves disposition-gated). Storyteller aggression, targeting bias, and frequency become the flagship self-hosting settings — named storyteller presets ("vindictive" leader-hunters vs. gentle casual-server personalities) rather than raw config numbers.

---

## 10. Bots

Two bot types, both built as **reactive rule-based systems using the same player-facing controls** as humans, keeping them tractable to build.

### Stabilizer / Guild Bots

These fill idle slots, provide liquidity, and dampen (never amplify) volatility. They run **production-bias presets** (Producer, Stockpiler, Trader), trade within **bands around a rolling average price** so they can't amplify panics, operate under **budget/inventory constraints** so their predictable bands can't be farmed as an arbitrage vending machine, and negotiate **reactively only** — never initiating blockades, takeovers, or aggressive proposals.

Politically, the key framing is **bots as constituencies, not politicians**: each NPC guild has legible standing interests (the refiner bloc always votes for fuel liquidity, the territorial bloc always defends property rights), and political skill comes from _humans_ courting these predictable blocs. Predictable bot votes make players feel clever for whipping the vote; unpredictable ones make players feel cheated by dice — and it keeps small servers politically playable, with bots as terrain rather than rivals.

Layered on top is a **disposition system**: each bot guild tracks a relationship with player guilds, and votes resolve as _standing interests + disposition modifier_. Disposition moves **only on costly actions** (honored contracts, favorable toll rates actually used, votes cast in their favor) so it can't be farmed with cheap gestures; **grudges accumulate faster than goodwill**; it's **coarsely visible** (hostile/cold/neutral/warm/allied, with recent grievances noted); it **decays slowly toward neutral** so relationships need maintenance; its voting weight is **capped** so friendship bends a vote but never owns it; and it explicitly **never touches prices**, or friendly bots become exploitable discount vendors. Disposition also feeds the storyteller's targeting and advance-warning logic.

Bot scope is tiered: (1) passive idle-guild bots running offline players' ventures on last-set parameters, (2) reactive defensive bots, (3) NPC filler factions with simple archetypal personalities, and (4) fully autonomous AI guilds as a "someday" feature. V1 targets tiers 1–3. Bots also double as a **volatility dial** for server owners and a **low-stakes onboarding tool** for new players' first negotiations.

### Pirate Bots

A pure ambient hazard, deliberately distinct in players' mental models: no negotiation, no reputation, no voting. Activity concentrates in **unclaimed/contested/low-security space**, reinforcing the value of patrolled territory. Targeting is simple heuristics (shipment value, defense rating, route security), presence escalates with events like fuel shortages, and losses are **non-attributable** — no legality votes, no political fallout, just the risk of doing business, which is a useful pacing tool. Captured goods can re-enter the market at a discount through **black-market fencing**. Crucially, **human piracy is an emergent playstyle** using the same mechanics — but attributable, and therefore subject to legality consequences, giving a clean line for when the political machinery engages. This attributable/non-attributable line is what governs the Syndicate Hauler's exposure (Section 6). Piracy risk also seeds a **defense/security venture category**: escorts, defensive tech, and insurance as products.

---

## 11. The Narrative Layer: The Rebellion and the Ancients

The most recent conceptual expansion adds two discoverable background storylines, designed as renewable content generators rather than plot arcs.

### The Rebellion

The rebellion's core mechanic is a **"thousand cuts" containment tax**: larger guilds face growing, diffuse strain — more defense spending, switching to smaller and less efficient transports that are harder to target, council attention diverted to security votes — rather than one clean debuff. There's no single lever to optimize against; a guild chooses _where_ to eat the cost, preserving agency while capping runaway growth by attrition.

Missions are delivered as **cover, not announcements**: pro-rebellion missions are disguised as mundane tasks ("fly a ship through this sector") that secretly enable recon or agent insertion, and the player may not fully know what they enabled. Resulting debuffs on target guilds spawn an **emergent, unproven accusation web** — the victim may suspect an uninvolved rival — explicitly designed to echo the social dynamics of _The Resistance_, where the value lies in ambiguity and social fallout rather than resolved truth. Anti-rebellion missions are deliberately harder to complete than pro-rebellion ones, encoding "quashing costs more than supporting" through mission design.

Mission generation is **adaptive and rival-aware**: the generator routes missions toward guilds already in friction (recent disputes, toll conflicts, takeover attempts), extending the storyteller's surface-area principle into a social-graph-aware version that pours narrative fuel on existing conflict. The **council is the delivery mechanism** — missions layer onto existing votes ("ensure this vote passes") with payouts as covert transfers through existing channels, and two players can receive conflicting missions on the same vote, turning ordinary council sessions into hidden-agenda showdowns.

**Alignment is emergent, not declared**: which missions a guild is offered is driven by relative standing (larger guilds statistically benefit from suppression), with the threshold set relative to current server rank rather than absolute size, smoothed with hysteresis to prevent flip-flopping, and carrying sticky history so a former rebel's past leaves an echo.

The rebellion also motivated a **spy/intelligence layer**: intelligence produces **evidence of varying reliability**, never binary proof. Cheap intel is rumor-tier and possibly plantable; expensive intel is trustworthy. Evidence strengthens or weakens council accusation votes, but resolution stays a council judgment call. This introduces counter-intelligence as a defensive venture category, spawns the **spymaster** archetype, carries exposure risk mirroring the sabotage design, and resolves the discovery-gating question: intel investment _is_ the gate.

### The Ancients

Discovered Ancient technology follows a **boom-bust single-object design**: the same artifact that gives a small guild a genuine efficiency edge later suffers a "freak accident" — destroying ventures and dealing an economic blow — once the guild has scaled or the tech's natural window closes. Uplift mechanic and large-guild check are the _same object across its lifecycle_, one mechanic instead of two, with the threat built into the object's own decay curve rather than a size-triggered rule. It likely needs a visible shelf-life signal so the downside is telegraphed, though the failure itself may deliberately land in the "sudden" 30%. Multiple competing rebel factions were considered and **deferred to v2**.

### Server Lifecycle Implication

The narrative layer reframed a standing open question: the design goal is now a **perpetually running server**, not an arc with an ending. Storylines are renewable generators — as one thread resolves or depletes, the storyteller injects new plots, and individual resolutions act as **checkpoints that spawn the next thread**, not endings. A season/reset structure may not be necessary at all.

---

## 12. Emergent Guild Archetypes

None of these are hardcoded roles — they arise from the interacting systems, and the list has grown as systems were added:

- **Refiner** — profits from fuel processing; wants free-flowing fuel and low tolls.
- **Stockpiler** — profits from scarcity; benefits from tight markets and chaos.
- **Trader/middleman** — profits from liquidity and movement; wants routes to work above all.
- **Producer/manufacturer** — vertically integrates or specializes across the venture supply chain.
- **Raider/security provider** — profits from risk itself, exploiting it (piracy) or insuring against it (escorts, insurance).
- **Spymaster** _(new, from the intelligence layer)_ — profits from information asymmetry: gathering, selling, planting, and defending against evidence.

The first three form a deliberate three-way tension over the single lever of tolls, making council toll votes a genuine multi-party negotiation. Because these must stay **emergent**, the new-guild starter kit is deliberately archetype-neutral (Section 13) — nothing in a guild's opening position should nudge it toward one of these roles.

---

## 13. Onboarding & the New Guild

Onboarding was previously only an open question ("how do new players learn this many interlocking systems"). It now has a design, built entirely from mechanisms that already exist.

### Starter Systems — decided at seed time, not at signup

A new guild needs a viable home system, but on a mature server most of the galaxy's ~1,500 systems are long since claimed, and the good unclaimed ones may sit in hostile space a new guild has no business surviving in. So the starter pool is **reserved in the Galaxy Seed itself**:

- A tagged pool of systems (`starterEligible`), held back from general claiming, and **spatially distributed across sectors** rather than clustered in one arm — since this determines every new guild's neighbourhood.
- **The rule is simply: the system contains ≥1 Terran planet.** No separate node-count threshold is needed, because Terran's guaranteed resource spread (Section 2) makes every Terran planet starter-viable by construction. The old "Type A planet" convention from open question #29 is retired — Terran *is* Type A; there was never a need for a resource-viability tier layered on top of the physical archetype.
- A new guild starts specifically on the system's **Terran planet** — the homeworld — not on an arbitrary planet in it.
- Assigned to a new guild on creation.
- Protected in practice by the storyteller's existing "small guilds fly beneath notice" rule (Section 9) — a reuse, not a new mechanism.
- Backed by the **rare-tier proximity guarantee** (Section 2): ≥2 rare-tier planets within ⅓ galaxy radius, so a starter guild's path to advanced manufacturing is expensive but never blocked.

*(Status: **designed; not currently implemented in the repo** — same situation as the archetype work (§2, §16). The 15-07 session reported it implemented, with 393 of 1,500 systems tagging starter-eligible on seed 7331 across all 16 sectors, but the code was never saved. Those figures become verification targets for Track G. Open question #30 is answered in design, unproven in code.)*

Worth noting what this quietly costs: because Terran is both the homeworld archetype *and* the only source of a guaranteed full resource spread, a guild that never leaves its home planet has a real, if slow, self-sufficient economy. That was deliberate — but it means the pull to expand has to come from *volume and specialisation*, not from missing resources.

### The Vehicle Gate

Other planets in a new guild's **own** system are visible and mineable in principle, but gated behind the guild's **first vehicle** — deliberately not behind claim rights or a tech tree. Making it specifically a vehicle means the gate teaches the manufacturing loop and the logistics layer at the same time, and it's the reason the Syndicate's transport scope is drawn so narrowly (Section 6): if the Syndicate would ferry your mining rig to the next planet, the gate dissolves.

### The Starter Quest

The Syndicate's first quest asks a new guild to **produce a set quantity of Titanium**; the reward is its **first Vehicle**. Titanium is the right ask precisely because it's unremarkable — a common structural metal, guaranteed ×2 on every Terran homeworld, and the obvious "first thing you mine to build your first ship." Nothing about it nudges a guild toward Refiner, Stockpiler, or Trader, which keeps the kit archetype-neutral (Section 12). Two details matter mechanically:

- **Progress is checked against a lifetime-production counter**, never current stockpile. A new guild is *encouraged* to sell as it goes (that's the whole point of the marketplace introduction), and checking stock would punish exactly the behaviour being taught. This is why the Guild entity carries a monotonic `lifetimeProduced` field (Section 15).
- **It is a one-off.** Afterward the Syndicate pays ordinary market price, explained narratively as the introductory offer ending.

The Syndicate marketplace itself is **an open market with a friendly face — not a safety net**. Real prices, real volatility, no permanent guaranteed rate. The starter quest asks for a *quantity produced* precisely so a new guild can complete it without being punished by a bad market. Combined with Syndicate public transport (Section 6), a guild with zero fleet can still trade from minute one — at the cost of a doubled round-trip and a fee.

### The Starter Kit

Basic mining and processing capability with generic automation defaults, deliberately **archetype-neutral**. Nothing in it — no oversized storage that rewards hoarding, no sell-immediately defaults — should bias a new guild toward Refiner, Stockpiler, or Trader (Section 12).

**Still unspecified**: what makes the *second* vehicle attainable once the Syndicate's free first one is spent. Presumably normal manufacturing, but unconfirmed (open question #8).

---

## 14. Architecture: Real-Time, Persistent, Self-Hosted

The game is **real-time and persistent** in the early-2000s browser-game tradition — things happen while you're away, and being present at the right moment matters. Servers are **self-hostable** with tunable config (fine severities, vote windows, tick rates, starting resources, bot density, and — most evocatively — storyteller presets) supporting play styles from casual/stabilized to hardcore/cutthroat. The game is deliberately **not "fair" by strict competitive standards**, leaning into asymmetry and real-world time investment as part of the genre's authentic appeal.

Mechanically: **tick-based resolution** for production and pricing on a server heartbeat, **time-windowed governance** for votes, disputes, and takeover bids, and **multiple simultaneous real-time clocks** (shipment arrivals, vote closures, stockpile statuses, bid deadlines) as the intended source of the "always something to check on" tension — which makes **legibility** (a clear dashboard/notification system) a first-order design priority so the tension excites rather than overwhelms. A lightweight master-server/listing layer for browsing public galaxies is a possible future addition.

A **one-minute heartbeat** is the current working assumption (open question #5 remains open). One clarification that falls out of it: the tick is not the unit everything resolves *on* — it's the clock that keeps *checking* whether anything is due. Production and pricing resolve every tick; a council vote open for six hours or a shipment in transit for days resolves on its own real-time deadline, which the heartbeat merely notices has passed. A one-minute tick also means the loop runs ~1,440 times a day forever, which puts real weight on each tick being cheap (Section 15's discrete-event scheduling) and **crash-safe** — the server must be able to restart and know exactly which tick it was on without double-applying or skipping.

### Tech Stack

This is **not a game engine** project. Unity, Godot, and Unreal are built for real-time 2D/3D with physics and rendering pipelines; strip away the theming and this game is a **persistent web application** — a database holding state, a server advancing it on a tick, a browser page displaying it. Reaching for an engine would mean learning a new language and a pipeline the game doesn't need, to build something that is fundamentally about *state*. Four layers:

- **Client rendering**: two surfaces, different technologies for different jobs. The **spatial galaxy map** is plain Canvas 2D, as already built in the map prototype and the seed viewer — already handling pan/zoom/rotate and level-of-detail switching. Upgrade path if it ever strains at scale: **PixiJS** (2D WebGL), same JavaScript mental model, faster with thousands of moving things. Not needed yet. The **System & Planet Index** (Section 16) is plain HTML/CSS/DOM instead — it's structured text and cards, not a scene, so Canvas would add cost for no benefit.
- **Server runtime**: **Node.js**. Every line of JavaScript already written — the RNG, the hex math, the seed generator — runs unmodified on a Node server. This isn't adopting a new language; it's moving trusted code from a browser tab to an always-on server.
- **Database**: **PostgreSQL**, once live state outgrows JSON. The specific reason is not preference: Postgres gives real **transactions** — guaranteed all-or-nothing writes — off the shelf, which is the direct mechanical answer to the atomicity invariant (Section 15). Hand-rolling that guarantee is exactly the work nobody should be doing.
- **Client–server communication**: plain **HTTP** request/response to start. The game is tick-based, not twitch-reflex, so "refresh and see what happened" is authentic to the genre and fine for a long while. **WebSockets** (live push — "your shipment arrived") are a legitimate later upgrade, not an early requirement.

None of this stack matters until persistence enters the picture (Phase 2, Section 17). The early phases stay plain HTML/JS with no server and no database, on purpose.

---

## 15. The Galaxy State: Data Architecture

The single most consequential technical question for this game is how galaxy state is **shaped and updated** — not where it's stored. Storage is swappable and low-stakes; the *shape* of the data is expensive to change once a live galaxy holds real player data, and the *update discipline* is where economic games die. This section is the written contract the code is checked against.

### 15.1 Four Layers

The galaxy is not one flat pile of numbers made up of each guild's stats. It is four layers, and almost all the difficulty lives at the boundary between two of them:

- **OWNED** — numbers belonging to exactly one guild, changed only by that guild. Credits, hoards, ventures, drones, vehicles. *Easy: the galaxy total of anything owned is just the sum across guilds.*
- **SHARED** — numbers belonging to no one, acted on by several guilds at once. Market price, the fuel utility's reserve, territory ownership, tolls, open votes. *Hard: this is where contention — and most of the actual game — lives. "A resource everyone needs and no one fully controls" is the project's core premise written as data.*
- **IN-FLIGHT** — numbers that exist between owned and shared while something moves. A shipment in transit. *The soul of this particular game, and the layer most often forgotten in a data model and then painfully bolted on.*
- **GLOBAL** — the conductor: tick counter, storyteller state, server config.

The intuition that "the galaxy is just the sum of what guilds own" is right for the OWNED layer and wrong for SHARED — and that distinction, not any storage choice, is what makes multiplayer hard.

### 15.2 Conventions

Boring rules that exist to prevent drift between independently-written pieces of code:

- **Money is stored as integer whole credits.** Never floating-point — drift silently violates conservation over thousands of ticks.
- **Fuel and goods are integers** in v0 (fixed-point later would be a deliberate migration, not an accident).
- **The word is `guild`** — never `faction`, `house`, or `player` — for the economic actor.
- **Manufacturing *tiers*, never manufacturing "phases."** Tier 1 Raw → Tier 2 Processed → Tier 3 Parts → Tier 4 Constructed Assets. "Phase" is reserved exclusively for the development roadmap; the Marketplace thread's phase-tab vocabulary is retired so the two numbering schemes can't collide. *(Adopted 17-07-26.)*
- **Ownership has a single source of truth.** Territory ownership lives on the map; a guild's "list of territories" is a *derived view*, never written to directly.
- **Every ID is stable and unique**, never reused, even after the thing is destroyed.
- **Every mutation records the tick it happened on.** Cheap now; priceless when debugging "how did this guild get 40,000 credits."

### 15.3 Two Stores, Not One: Seed vs. Live State

- **Galaxy Seed** — static, generated once, small. Map shape, the ~1,500 solar systems, their planets, and each planet's resource nodes. Barely changes after generation (new systems don't spawn mid-game), so a plain JSON file is the right tool.
- **Live State** — the OWNED/SHARED/IN-FLIGHT layers. Claims, ventures, drones, credits, prices, shipments. Mutates every tick, forever, under real concurrency — needs a real datastore with atomic, crash-safe writes, not a hand-rewritten file.

They link **by reference only**: a venture stores which resource-node `id` it occupies; it never duplicates the node's data. Conflating the two is what would make a single galaxy file feel enormous and slow — separating them is what keeps the seed under a megabyte.

The **derive, don't store** principle does most of the work here. Of ~101,000 hexes, only the ~1,500 systems and the scattered outposts/gates carry an explicit claim; the other ~99,500 hexes' ownership is **computed** from the nearest claim within its radius. The hex lattice itself is never stored at all — it's pure geometry, reproducible from `galaxyParams` (radius, hex size) plus the deterministic seed number. A moveable asset (transport, drone shipment) **stores its own location**; "what's on this hex" is a *lookup*, never data authored onto the hex — otherwise the same fact lives in two places and they drift.

### 15.4 Core Entities

**Guild** (OWNED): `id`, `name`, `isBot`, `credits` (≥0), `influence`, `fuelHoard` (≥0), `incomeRate` (the flat baseline allocation), `guildReputation`, `lifetimeProduced` (map good→int, **monotonic — only ever increases**; exists so starter-quest progress survives selling down stock, Section 13).

**Venture** (OWNED): `id`, `ownerGuildId`, `type`, `licenceId`, `siteId` (the resource node or leased site it occupies — reference only), `productionRate`, `inputStockpiles`, `outputStockpile`, `energyDraw` (spends from the fuel pool), `droneComplement` (min/max), `reputation`, `shareholders`, `automation` (thresholds/targets/stop conditions).

**Vehicle** (OWNED): `id`, `ownerGuildId`, `class`, `speed`/`capacity`/`defenseRating`/`fuelCostToRun`, `status`. *(The Syndicate Hauler is an instance of this with a very high `defenseRating` — not a special case.)*

**Drone pool** (OWNED): `ownerGuildId`, `role` (factory/security), `assignedTo`, `condition`, `maintenanceSpend`. *(Individual-vs-pool tracking still undecided, Section 4.)*

**Bot state** (OWNED): `productionBias`, `tradingBand`, `standingInterests`, `dispositions` (map guildId → {value, grievances}).

**Market** (SHARED, per good): `goodType`, `currentPrice`, `supplyDemandSignal`, `priceFloor`/`priceCeiling`.

**Fuel Utility** (SHARED, the special market): `reserveLevel` (≥0), `currentPrice`/`priceBand`, `ownershipStakes` (capped ~20–25%), `interventions` (active council measures), `refiningContracts`. Processed Deuterium Fuel is not privately tradable, so this *is* its market.

**Territory Map** (SHARED): one row per **system, outpost, or gate** — never per hex — `claimId`, `ownerGuildId` (single source of truth), `claimedAtTick`, `claimRadius`, `securityLevel`, `contested`.

**Toll Gate** (SHARED, single-hex claim in the Outpost family): `id`, `ownerGuildId`, `coords`, `anchorId` (the system *or* outpost it anchors to — reference only). Placement is validated at creation: within the max hex distance of its anchor. Unlike an Outpost — which anchors only to a system — a Gate may anchor to either, which is the one extra hop enabling ~20-hex reach (Section 2).

**Routes/Tolls** (SHARED): `id`, `ownerGuildId`, `path`, `toll`, `security`. A **Toll Path** specializes this for the gate-to-gate case: `gateAId`/`gateBId` in place of a generic path, both gates owned by the same guild. Always gate-to-gate; a shipment may only enter or exit at a gate; an outpost is never an endpoint.

**Council** (SHARED): `voteId`, `topic`, `options`, `tallies` (weighted by influence), `openTick`/`closeTick`, `status`, `rulings` (with decaying `precedentWeight`).

**Shipment** (IN-FLIGHT): `id`, `cargo`, `shipperGuildId`, `vehicleId`, `originId`/`destId`, `routeId`, `departureTick`/`arrivalTick`, `currentRisk`, `status`. `routeId` may reference a Toll Path — see §15.6 for why that case is dramatically cheaper.

**Global**: Galaxy Clock (`currentTick`, `tickRate`), Storyteller (read-signals, targeting weights, queued events), Server Config (the self-host levers, incl. storyteller preset).

**Galaxy Seed entities** (separate store, §15.3): Solar System (`id`, `coords`, `name`, `claimRadius`, `ring`, `starterEligible`, `planets`), Planet (`id`, `archetype`, `stats` — atmosphere/size/climate/biomes, still empty, see Section 2, `resourceNodes`), Resource Node (`id`, `resourceType`). The term is **resource node** everywhere, in both this document and the code — never "mining slot."

Two fields were deliberately **removed** from Resource Node rather than left unfilled:

- **`richness` is gone entirely.** It added a per-node quality dial the game doesn't need — a node's *presence* is what matters, and starter-viability is a clean count, not a threshold across two variables. Cutting it removed a whole design surface (how is richness rolled? what reads it?) that had no answer and no consumer. If production rate ever needs to vary per node, that's a deliberate re-addition, not a gap.
- **`ventureId` is gone from the seed**, because it was never seed data: which venture occupies a node is a **live-state fact that changes during play**. Storing it in the static seed would violate the seed/live split *and* single-source-of-truth in one move. It belongs in a claims-style map (`resourceNodeId → ventureId`) once live state exists — exactly the pattern `generate_test_claims.js` already uses for territory. (Note this is the same fact as Venture's `siteId` above, seen from the other end; `siteId` is the authoritative one.)

Both `Planet.starterViable` and `SolarSystem.starterEligible` are **derived, not authored** — computed from archetype + nodes, per derive-don't-store. (`starterEligible` is materialised into the seed file as a convenience for readers, but it is a pure function of the planets beneath it, never independently edited.)

### 15.5 The Invariants

Everything else — types, tests, database transactions — exists to protect these. If nothing else in this section is preserved, preserve these.

1. **Conservation of fuel** — created only by production, destroyed only by consumption or decay. At all times, `Σ guild hoards + reserve + fuel in transit = total produced − total consumed`.
2. **Conservation of credits** — a trade moves credits from buyer to seller, equal and opposite, net zero. The *only* sanctioned sources/sinks are the baseline allocation and explicit sinks (Syndicate fees, fines — and a fine paid to a victim *moves* credits, it doesn't vanish them).
3. **Non-negativity** — hoards, credits, reserves, stockpiles stay ≥0. An operation that would break this **fails**, or floors and records a shortfall (the fuel simulator does the latter). Decide which per field; never let it silently go negative.
4. **Atomicity of shared-state mutation** — any read-modify-write on SHARED state (buying from the reserve, claiming a resource node, casting a vote) must be atomic. Two actors must never interleave on the same shared number. This is the entire class of bug behind every money-printer and item-dupe exploit in every game economy ever shipped, and it's the reason multiplayer is deferred rather than attempted early.
5. **Single source of truth** — no fact authoritatively stored in two places.
6. **Vote-weight integrity** — total weight on a resolved vote equals the sum of participating influence at close; influence can't be counted twice, or spent and still voted.
7. **Realized-on-arrival** — in-flight cargo has no realized value until delivered (or fenced). This is Section 6's central tension, as data.
8. **Reputation moves only on measurable events** — missed deliveries, broken contracts — never on vibes, or the takeover threshold becomes a dogpile cliff.
9. **Deterministic tick order** — the same state plus the same inputs always yields the same next state. Non-negotiable for debugging and fairness.

### 15.6 The Tick Loop

| Resolves on the **tick** | Resolves on a **player/bot action** |
|---|---|
| Venture production & consumption | Setting a venture's parameters |
| Market & fuel price recalculation | Placing a buy/sell order |
| Baseline allocation | Setting/negotiating a toll |
| Shipment progress & arrivals | Launching a shipment |
| Storyteller reads signals, may fire an event | Casting a vote (within its window) |
| Vote windows closing & resolving | Claiming/contesting territory or a resource node |

**Fixed within-tick order** (satisfying invariant 9): `1 production → 2 consumption/energy → 3 price recompute → 4 scheduled events → 5 arrivals → 6 baseline allocation → 7 storyteller → 8 vote closures`. *(Amended 17-07-26 from the earlier seven-step order: the Phase 1 build prompt inserted step 4, **scheduled events**, as the named home for anything with a due-tick — contest-window closures now, the change calculator's interceptions later — giving the seam this section already asked for an explicit slot of its own, distinct from applying the arrivals themselves.)* Pin this down early; it's cheap now and painful to retrofit. Production must resolve before pricing, and pricing must be final before anything reads it — with one refinement from the simulator port (§8): the price step 3 publishes is the **posted price** governing the *next* action window, so a tick's trades execute at the price computed the tick before, exactly as the spreadsheet resolves a turn. *(Proposed port semantics, open question #42.)*

**Move validation happens on arrival, not in a batch at tick's end.** Validate each incoming move against state-as-it-stands — start-of-tick *plus everything already accepted this tick* — and queue only the survivors. Validating a batch of individually-plausible moves against the same stale start-of-tick snapshot is how a guild with 100 credits gets three "spend 80" orders all approved. Contested claims (two guilds, one free resource node, same tick) resolve **first-valid-wins**, the same discipline as any shared-state write.

**Discrete-event scheduling — don't recompute what's already knowable.** Future state splits into two kinds:

- **Pure schedule.** A transport on an uncontested route needs *no per-tick work at all* until arrival — its position at any future tick is arithmetic on `departureTick`/`arrivalTick`/`path`. This is why write cost scales with what **changed**, not what **exists**: a galaxy full of settled ventures and in-flight cargo is nearly free to tick.
- **Live-recomputed.** Anything touching SHARED state cannot be scheduled ahead, because its outcome depends on what *other* actors do between now and then. A venture's *rate* is knowable; what it actually achieves depends on the fuel pool everyone is drawing from, which nobody has decided yet. Production, consumption, and pricing must be recomputed fresh, every tick.

A schedule is a **prediction, not a guarantee**. The future **change calculator** (interruptions, piracy rolls, blockades, rerouting — deliberately deferred) will need to intercept scheduled arrivals before they apply. Keep "resolve a scheduled arrival" as its own explicit, named step in the loop *now*, even before that calculator exists, so there's a clean seam to hook into rather than logic buried inline.

**Toll Paths are the cleanest case of the above — and a concrete constraint on the change calculator's shape.** On an ordinary route, a transport crosses hexes belonging to different owners with different security levels, so an interruption check in principle runs *per hex, per tick*, for the whole journey — the risk profile changes mid-route. A Toll Path can't: because a transport may only enter and exit at a gate (never mid-path), and the whole corridor belongs to one guild, the entire path has exactly **one risk profile, known in full at entry**. That collapses the check from *O(hexes crossed)* to a **single roll made once at entry** against the path's (vastly reduced) piracy chance. A transport "on path" is logged once with a known exit tick and needs no further attention barring that one roll.

The constraint this places on the change calculator, once built: **it must operate at the granularity of a route segment (toll path vs. open space), not per hex.** Open-space legs still need the general check; toll-path legs never do. Note also that this property depends entirely on the gate-only-entry rule — if gates ever permit mid-path exits, it is lost.

---

### 15.7 Concurrency & Scaling Under Load

*(Added 17-07-26. Resolves part of open question #9; the method below was already implied by invariant 4 and §15.6's validate-on-arrival rule — what's new here is the load reasoning, the named escape hatches, and the trigger for reaching for them.)*

**The model, restated plainly.** There is exactly one live state, in Postgres, on the server. A player action is an HTTP request the server validates *immediately* against current state and applies in a transaction there and then — which is what makes "resources deducted instantly, asset completes N ticks later" work: the spend is an instant validated write, the completion is a scheduled event resolving on its due tick (§15.6's pure-schedule case). There is **no per-user state file**, and no batched merge of private copies into the galaxy at tick boundaries. That pattern was considered and rejected: it duplicates authoritative facts (violating invariant 5), and batching individually-plausible moves against one stale snapshot is precisely the failure invariant 4 and §15.6 exist to prevent. It also doesn't reduce contention — it only relocates it to the tick boundary, while adding up-to-a-tick latency to actions that could have been instant.

**Concurrent writes to the same shared state are the normal operating condition, not an edge case.** Many guilds hitting the market, the reserve, and contested claims in the same second is expected. Postgres transactions make that safe by serializing writes on the row touched: the second writer sees the already-updated value, not a stale one. A guild losing a race to claim a node is a real economic outcome — first-valid-wins — not a data bug.

**Load reasoning (estimate, not yet measured).** The scaling unit is *transactions per second against the hottest single row*, not player count. A single row with synchronous commit serializes at roughly the low hundreds/sec on modest hardware; Postgres overall handles far more, so the whole-database throughput is never the binding constraint. Humans self-throttle at ~0.2–0.5 actions/sec at peak, and actions spread across many different shared rows (per-good prices, individual gates, individual nodes) rather than one. **At ~1000 actors, steady-state load sits comfortably inside that envelope, and no architectural change is warranted.** The concentrating case is a deliberate squeeze — a shortage event pushing many guilds onto the *same* reserve within seconds — which is bursty, on the order of tens/sec, not sustained thousands.

**Bots are the wildcard, and rate-limiting them is the mitigation.** Bots have no typing-speed limiter; unthrottled, a handful could out-write a thousand humans and saturate a hot row. **Decided: bots are rate-limited to human-like action rates** — a concurrency control in its own right, not merely an economic one. (The existing trading bands and budget/inventory constraints incidentally cap write-rate too, but were designed for anti-arbitrage-farming and are not to be relied on as the throttle.)

**Standard hygiene as population climbs**, none of it architectural: connection pooling (PgBouncer — Postgres caps concurrent *connections*, not concurrent users) and read replicas for read-heavy surfaces (market history, territory map) so dashboard reads don't compete with the write path. WebSockets over polling also stops being a nicety at that scale.

**Escape hatches, deliberately not built yet.** Both are documented so the reasoning isn't reconstructed from scratch later, and neither is warranted until measurement says so:

- **Single-writer ordered queue.** Instead of many writers contending for row locks, append every action to an ordered intake queue (contention-free — appending isn't modifying a shared number) and have one sequential process drain it against in-memory state, validating each against the state as it stands after everything before it. Same validate-in-order discipline as §15.6, no lock contention; bottlenecked only by one core's throughput. It drains continuously, many times a second — it does *not* wait for the tick, so shared-state actions stay instant.
- **Regional partitioning of singleton SHARED resources.** Split the one galaxy-wide reserve/price into per-sector pools with cross-region arbitrage. Note this is a *design* change with gameplay upside (regional scarcity and arbitrage are already Trader-archetype behaviour), not merely a performance patch — but it makes "the fuel price" ambiguous without a location, and needs its own rules.

**The trigger.** Neither hatch is opened on speculation. **Phase 3's adversarial test is the measurement that decides it, and its scope is hereby widened**: not "two clients hammering a shared number" but a simulated ~200-actor squeeze against a single row, at realistic burst rate. Until that test runs, every number in this section is an estimate and must be labelled as one.

**Scaling outward is already solved by self-hosting.** A popular game is many small independent galaxies, each with its own database and its own ceiling — not one instance absorbing the whole playerbase. Note the open counter-consideration: the premise is a *collective* galaxy of guilds competing, so if a single shared galaxy is ever targeted at ~1000, the political layer (§ council voting, disposition) was designed for a legible ~5–50 body and would need delegation or blocs, and the starter-eligible pool (§13) was sized for tens of new guilds, not hundreds. Both are design problems that surface *before* the database does.

---

## 16. Galaxy Seed Generation & Client Tooling

The galaxy is generated **once, offline, by a standalone script**, which writes a JSON file that everything else reads forever after. This is a deliberate split from the map prototype, where generation and rendering were the same act (the browser regenerated the galaxy on every page load, purely to have something to draw).

**Determinism is a load-bearing property, not a nicety.** The whole galaxy is a pure function of one integer seed. This has been verified in both directions: the same seed produces byte-identical galaxy content across runs, and different seeds produce genuinely different galaxies. It buys two things — **reproducibility** (rerun seed 7331, get the identical galaxy, invaluable for debugging) and **shareability** (a self-hoster can publish a seed number and anyone can regenerate their exact galaxy without transferring a file).

### The Pipeline

*(Status note, updated 17-07-26 after a partial recovery. Two generators now sit in `tools/`. The committed `generate_seed.js` implements only steps 1–3 and 7, with bare placeholder planets. The recovered `generate_seed_recovered_partial.js` additionally implements steps 5, 6, 8 and 10 — archetypes, resource nodes, starter-eligible tagging, and the validation pass — as working, verified code (`validation: PASSED` on seed 7331), but is **not** merged into the main generator and is committed as a reference checkpoint only. Steps 4 and 9 — ring classification and the rare-tier repair pass — exist in **no** code anywhere; their descriptions below, and §2's ~41%/~3.6% figures, remain pure specification. The check marks below record that the design questions are answered, not that code exists. See roadmap Track G, which also carries a known planet-count discrepancy between the two generators.)*

1. **Hex grid + spiral-arm eligibility** — geometry only, never stored. ~101,287 hexes total, of which only ~1.5% will hold a system.
2. **System placement** — deterministic shuffle of arm-eligible hexes, take the first ~1,500.
3. **System naming** — sector-themed prefix derived from angular position, plus a catalog number derived from coordinates (e.g. `THE-2716`), aiming for astronomical-catalog flavour while staying traceable back to position.
4. **Ring classification** — each system tagged inner/middle/outer by distance from the Citadel, feeding the rare-tier gradient (Section 2).
5. **Planets** — count generated (1–6 per system, averaging ~3.5), then each planet gets an **archetype** via ring-weighted random draw. `stats` (atmosphere/size/climate/biomes) remains empty — the one real gap left in this step.
6. **Resource-node generation** — archetype-driven pool and node-count range. Terran's guaranteed-minimums-plus-random-fill and Oceanic's ≥2-Deuterium floor are the two departures from a plain random draw.
7. **Outposts** — isolated, minimum-separation scatter in blank space.
8. **Starter-eligible tagging** — ✅ *designed (see status note above).* A system qualifies with ≥1 Terran planet.
9. **Rare-tier repair pass** — ✅ *designed (see status note above).* Tops up any starter system short of its ≥2-rare-tier-within-⅓-radius guarantee by converting the nearest eligible non-Terran, non-rare-tier planets in range. On seed 7331 it fires **zero times** — the gradient alone already clears the bar, so this is a safety net for unlucky seeds, not the primary mechanism. Stress-tested by temporarily raising the minimum from 2 to 50, where it correctly applied 420 repairs and still validated.
10. **Validation pass** — ✅ *designed (see status note above).* Asserts every `resourceType` appears somewhere in the galaxy, the starter pool is non-empty and spread across all 16 sectors (not just healthy in aggregate), and the rare-tier guarantee still holds post-repair. Results surface as `validation.passed` / `validation.issues` in the seed and on the command line. Not yet covered: illegal claim overlap.

*(Ordering is forced, not arbitrary: archetype must precede node generation because nodes draw from the archetype's pool; starter tagging must follow node generation because it derives from what's actually there; the repair pass must follow tagging because it only acts on starter systems.)*

The generator and the client-side seed viewer **deliberately share the same hex-geometry and RNG code**, so they can never silently disagree about what a given seed produces — the viewer regenerates the lattice and starfield from `galaxyParams` rather than reading stored hexes, which proves the derive-don't-store bet from the other end.

### Current Tooling

*(Corrected 17-07-26 against the actual repo. The previous version of this list described the unrecovered 15-07 build; paths now reflect the repo layout.)*

- `tools/generate_seed.js` — the generator, currently at pipeline steps 1–3 + 7 only: systems, naming, bare placeholder planets (`{id}`), outposts, the Citadel. Writes a **~517KB** seed for a 101,287-hex galaxy (1,500 systems, 5,290 placeholder planets, 9 outposts). Stores no hexes. No archetypes, rings, resource nodes, starter tags, or validation — Track G re-implements those from §2/§13/§16. Determinism verified 16-07 by running it: same seed → identical content, different seed → different galaxy. One nuance: the output embeds a `generatedAt` wall-clock timestamp, so the *file* is not byte-identical across runs even though the *content* is — either drop the field or accept content-level determinism as the claim.
- `data/seed.json` — the reference seed (7331). Regenerable, but committed deliberately as the shared fixture the viewer, the claims tool, and future tests all exercise. Verified 16-07 to be exactly what the committed generator produces for seed 7331.
- `tools/generate_test_claims.js` — **test tooling only, not architecture.** Reads a seed and writes a *separate* claims file assigning systems, outposts, and toll gates/paths to test guilds, respecting the real placement rules (outposts ≤10 hexes of an own system; gates ≤10 of an own system *or* outpost; paths strictly gate-to-gate). It exists purely so rendering can be exercised against realistic contested data, and it deliberately obeys the seed/live-state split even though it's throwaway. Usage: `node tools/generate_test_claims.js [seedFile] [claimsSeed] [outPath]`.
- `data/test_claims.json` — reference claims (claims seed 4242) for the seed above: 20 guilds, 109 claimed systems, 60 guild outposts, 49 gates, 29 paths. Same metadata nuance as the seed: the file embeds `generatedAt` and the input `seedFile` path, so only its *content* is byte-stable across runs.
- `client/seed_viewer.html` — loads a seed (and optionally a claims file) via file pickers and renders it. Territory fills at all zooms; true hex borders above 4× zoom (drawn live near the focus, since there's no stored lattice); hollow-ring "stargate" hexes for toll gates, dashed guild-coloured toll paths, deliberately identical diamond markers for outposts and gates; click any hex — system, guild outpost, toll gate, Syndicate outpost, Citadel, claimed territory, or empty space. **Renders no `archetype` or `ring`** — the seed contains neither until Track G lands.
- `tools/generate_seed_recovered_partial.js` — recovered 17-07-26 from a local copy of a 15-07-era session; **a reference checkpoint, not the working generator.** Implements pipeline steps 5, 6, 8 and 10 (archetypes, resource nodes, starter tagging, validation) on top of 1–3 and 7; verified to run, reporting `validation: PASSED` and 361 starter systems on seed 7331. Contains no ring classification, no rare-tier gradient, and no repair pass. Not merged into `generate_seed.js` because its RNG stream diverges from the committed generator's — it yields 5,089 planets for seed 7331 against 5,290 — so the two are not a clean subset/superset. Reconciling that is Track G work.
- `client/system_planet_ui_mockup.html` — recovered 17-07-26; the System & Planet Index UI prototype described below. Still standalone, still running on hardcoded demo data.
- `analysis/fuel_market_simulator.xlsx` — the hand-played fuel market (Section 8), now transcribed into this document as the port contract.

**Referenced but missing from the repo** — built in sessions whose artifacts were never saved; rebuild against the documented spec: `galaxy-map-hex.html` (the original map prototype and JavaScript textbook) and `SyndicateMarketplace.jsx` (the Exchange mockup, specified in §5). Also named but not missing in any meaningful sense: `galaxy-state-model.md` (superseded by §15 — referenced only by an old code comment; nothing to recover).

*(Recovered 17-07-26 from the local machine and struck from the list above: `system_planet_ui_mockup.html`, now at `client/system_planet_ui_mockup.html`; and a partial 15-07 `generate_seed.js`, now at `tools/generate_seed_recovered_partial.js` — see Current Tooling above for exactly what it does and does not contain.)*

### The System & Planet Index UI

A **second client surface** alongside the galaxy map: a data drill-down for inspecting a system's planets and a planet's resource nodes, rather than a spatial view. Prototyped as `system_planet_ui_mockup.html` — plain HTML/CSS/JS, no build step, no framework, the same prototype-first posture as the map viewer.

This is deliberately **DOM, not Canvas**, which is a considered split from Section 14's rendering note rather than an inconsistency: the map is a spatial scene and belongs on Canvas; this is structured text and cards, where Canvas would cost hit-testing, text layout, and accessibility for no benefit. Two surfaces, two technologies, chosen per job.

**Layout.** Two columns: a fixed-width left index panel, and a right content area that is currently an empty-state placeholder on every view.

**The quarter-segment hero.** A circle positioned so only its top-right quadrant shows, clipped to the panel's bottom-left corner — a "rising body" read with no custom SVG or clip-path geometry. Its radius is viewport-relative (`clamp(200px, 30vh, 380px)`), so it scales with the window as originally intended, bounded so it can never geometrically overrun the panel and clip flat. It shows the star on the system page and switches to the planet's own art on the planet page.

**Art is per-archetype, not per-planet** — 9 images total, reused across every planet of that type. With ~5,200 planets in a seed, bespoke per-planet art was never viable; this was scoped up front rather than discovered later. Art repeats, data doesn't. Until real art exists, each archetype has a **layered-CSS-gradient placeholder** (mottled rock, oceanic bands, Jupiter-style banding, faceted crystalline, and so on) — every one is a single `background` declaration, one line from becoming a `background-image`, with `background-size:cover` already in place so arbitrary art dimensions just crop to fit. A persistent "ARTWORK PENDING" tag and a dashed ring keep the placeholder legibly a placeholder.

**System view — the planet list.** Planets are full-width tabs stacked **nearest-star at the bottom, furthest at the top**: a compressed orbit metaphor, where list order is data rather than decoration. Each tab's background is its archetype texture, with text at the bottom behind a gradient scrim (transparent at top so art breathes, opaque at the bottom where text sits) — legible regardless of what the eventual artwork looks like, with no assumptions about its composition. A borderless **3×5 pip grid** hugs each tab's right edge, tallying resource-node count at a glance without printing a number; it fills rightmost-column-first, and the 5-per-column capacity is derived directly from Terran's 15-node maximum.

**Planet view — the node list.** Nodes are much shorter tabs (28px, a third the height), with no artwork and no colour-coding — consistent with the decision that nodes carry neither richness nor a colour axis. Split horizontally: resource name on the left third, a venture-status control filling the right two-thirds. That control reads "Establish Venture" or the name of the venture occupying the node — a real affordance for a system that doesn't exist yet, clickable independently of the row itself. Both the row and the control open stub overlays that say "not yet instrumented" outright rather than faking data.

**Navigation.** Breadcrumb at the panel top; a dedicated "Return to System" button top-right, the mirror-opposite corner from the hero. An earlier version made the hero itself the back-action, but that affordance was hover-only (invisible on touch) and overloaded a decorative element with navigation — so the hero is now purely decorative and the nav is explicit.

**Visual identity.** Dark void, brass/gold ledger accent rather than sci-fi neon — "bureaucratic trading-guild instrument" over HUD/cyberpunk. Cinzel for designations (engraved star-chart feel), IBM Plex Sans for body, IBM Plex Mono for data and IDs. The 9 archetype colours are spread across the full hue wheel rather than clustered in the warm/brown range several archetypes would naturally suggest, so they stay distinguishable at small sizes.

**A naming convention fell out of the mockup** and is worth keeping: planets display as system name + roman numeral (`VELKAAN-114 IV`), derived from the system name and orbital order. Planets have no display name in the data model — only an `id` — and this gives them a readable one for free, with no naming pass and no new stored field.

**Known gaps:** hardcoded demo data (one system, six planets) — not wired to `seed.json`; the right-hand content area is empty on every view; no real artwork exists.

---

## 17. Development Roadmap

**The authoritative roadmap — per-phase goals, checklists, exit criteria, and live status — is [`docs/roadmap.md`](roadmap.md).** This section is a summary only, kept so the two documents can't silently drift: when they disagree on *status*, roadmap.md wins; on *design*, this document wins.

Sequencing is by **technical dependency and by what each phase teaches for the next** — deliberately not the order systems appear in this document. Every phase is a legitimate finish line on its own. Scope should be cut hard for the first shippable version: v1 might be 5–10% of this document.

- **Phase 0 — Prove it's fun, learn to code.** ✅ Done: the shipment lifecycle on paper, the spreadsheet squeeze (which worked, and surfaced #31), JavaScript learning ongoing.
- **Phase 1 — The economy as a playable single-player sandbox, no server.** ⬅ *Current.* **Scope deliberately widened 16-07-26** from the original one-guild spine: bot guilds, abstract-graph territory, tolls/tariffs, and negotiation are in, so the game's *shape* — territory worth holding, tolls worth negotiating, a squeeze worth fighting — can be felt before infrastructure gets built. The widening knowingly leaves two things unproven: persistence (Phase 2's job) and real player-vs-player trust (Phase 3+'s job). The trap named at the time still applies: Phase 1 territory is an abstract graph behind a world-interface boundary, **not** the hex galaxy — building real geography now would make Phase 1 quietly become Phase 4. Runs in three gated stages (read-and-report ✅ delivered 16-07; harness + walking skeleton; the sandbox).
- **Phase 2 — Persist and tick on a server**, still effectively single-player. Node, PostgreSQL, a heartbeat that advances the world while nobody watches.
- **Phase 3 — Multiplayer foundations.** Accounts, shared galaxy, atomicity load-bearing, the Exchange's player order book (§5).
- **Phase 4 — Territory, routes, tolls, travel time on the real map.** The world adapter swaps graph → hex; Toll Gates and Paths land here.
- **Phase 5 — The political layer.** Council, weighted voting, legality, fines.
- **Phase 6 — Bots and the Storyteller** (with the narrative layer as its stretch/v2 extension).
- **Phase 7 — Self-hosting, config, onboarding, polish.**
- **Track G — galaxy generation recovery** *(parallel track, not a phase)*: re-implement archetypes, resource nodes, the rare-tier gradient, starter tagging, repair and validation passes against §2/§13/§16, verify the 15-07 figures, and make it visible in the viewer. Schedulable any time; required before Phase 4.

**Where we actually are:** the map and territory tooling is well ahead; the economy — the thing the whole game rests on — has never run as code. Phase 1's Stage 1 (read-and-report) is delivered, including the repo reconciliation this consolidation absorbs; Stage 2 is blocked only on the decision checklist in roadmap.md. Nothing built so far has ever produced a good, moved a price, or drawn down a reserve in running software.

---

## 18. AI-Assisted Development: How to Actually Do It

Given the intent to build most of this with AI assistance and limited prior programming experience, three hard-won points that shape the whole workflow:

**AI sessions are stateless — the repo is the only shared memory the "team" has.** A fleet of AI "experts," each starting fresh with no memory of what any other decided, is not a standing team; it's the same intelligence prompted differently, re-reading the repo from scratch every time. The repo — code plus this document — is the only continuity, and the only *continuous* intelligence in the operation is the human. Keep it accurate and current, or nothing built against it will be consistent.

**Don't parallelize by module — the seams between systems are the hard part, and no expert owns a seam.** This game's entire thesis is interlocking mechanics: fuel touches ventures touches energy touches tolls. Splitting work across independent "fuel expert" / "ventures expert" sessions doesn't remove the integration work — it hides it in the gap between them, which is exactly where bugs live and nobody is responsible for catching them. Build **sequentially**, one module at a time, each new piece reading and conforming to what already exists. Prefer **vertical slices** (one thin end-to-end loop: produce a good → ship it → sell it → watch the price move) over horizontal ones (one system built fully in isolation).

**Compatibility checking needs a written contract, and mechanical enforcement beats an AI reviewer looking twice.** "Are these two systems compatible?" is only a meaningful question against a spec — Section 15's entity shapes and invariants *are* that spec, which is why they're written down. A stateless model asked "do these fit?" will often say yes while sailing past the seam, because it's reconstructing its understanding from scratch and has no memory of the decision the two systems were supposed to share. The strongest guarantee is **automated tests and schema/type validation that fail loudly and mechanically** the instant a contract is violated — they don't drift, forget, or hallucinate agreement. Use AI heavily to *write* those tripwires; don't rely on AI *as* the tripwire. An AI review pass is a fine supplement on top; it's a weak foundation by itself.

A corollary worth stating: if you ever wonder what a test should actually test, the answer is almost always "that one of the nine invariants still holds."

---

## 19. Consolidated Open Questions

From the baseline design work:

1. **Syndicate fuel-utility governance details** — exact voting mechanics, cap enforcement, and how cartel capture is detected and challenged. *(Allocation and anti-hoarding substantially answered 19-07-26 — pooled purchasing-power allocation, per-burn sizing, conditional refinery licensing; full model in `docs/fuel-allocation-model.md`, §8 summary. This **supersedes the earlier committed-capital allocation ratio** as the allocation mechanism, keeping only its hoard-valuation trick. Voting mechanics and cap enforcement remain open.)*
2. **Fuel price formula** — the hybrid algorithmic + council-intervention approach is set; the spreadsheet uses a reserve-based exponential curve as a working proxy, but no real formula is defined.
3. **Legality vote eligibility** — recuse involved parties, or let everyone vote (leaning toward everyone).
4. **Sabotage system scope** — real hidden-action mechanics vs. market-pressure-only for v1 (leaning toward the latter).
5. **Tick rate** — **one-minute heartbeat is the current working assumption**; still needs confirming against server cost and casual/async playability. Note the tick is a *checking* clock, not the resolution unit for everything (Section 14).
6. **Bot scope for v1** — confirmed leaning toward tiers 1–3, autonomous AI guilds deferred indefinitely.
7. **Shipment interception mechanics** — resolution of captured goods, insurance payouts, route risk calculation. The change calculator that will implement this is deferred, but **its shape is now constrained**: it must operate per route *segment* (open space vs. Toll Path), not per hex (Section 15.6).
8. **Onboarding** — *substantially answered* (Section 13): reserved starter systems, the vehicle gate, the Syndicate starter quest, an archetype-neutral kit. What remains: **what makes the second vehicle attainable** once the free first one is spent (presumably normal manufacturing, unconfirmed).
9. **Technical architecture** — *substantially answered* (Sections 14–16): four-layer state model, invariants, tick order, seed/live split, Node + Postgres + Canvas + HTTP. What remains: the actual server loop implementation, the PostgreSQL schema for the Section 15.4 entities, config-vs-hardcoded rule boundaries, deployment shape for a self-hosted instance, and the listing layer.
10. **Storyteller internals** — signals read, targeting weights, cadence, quantifying disposition and surface area.
11. **Disposition tuning** — which actions move it and by how much, decay rate, voting-weight cap, visibility presentation.
12. **Population scaling** — game feel at ~5/~15/~50 humans; minimum viable political population.
13. **Server endgame/lifecycle** — _substantially reframed by the narrative layer_: the perpetual-server model with self-sustaining storylines may make seasons/resets unnecessary.
14. **Vote-window fairness** — real-time windows punish time zones and sleep; longer defaults or queued conditional votes are candidate mitigations.
15. **Reputation inputs** — venture reputation must move on measurable events (missed deliveries, broken contracts), not vibes, or the takeover threshold becomes a dogpile cliff. *(Decided as a rule and now invariant 8; the exact event list is still unspecified.)*

Added by the narrative-layer thread:

16. **Proof vs. permanent ambiguity** for rebellion accusations, and whether rebellion-suspicion rulings need lighter consequences given weaker evidence.
17. **What counts as "effort"** in the containment tax — influence, venture capacity, fuel draw, player attention, or a blend.
18. **The pro-/anti-rebellion threshold** — where it sits and how relative standing is calculated and smoothed.
19. **Intelligence reliability tuning** — cheap vs. expensive intel, and what stops risk-free evidence-planting spam.
20. **Ancients downside** — guaranteed or probabilistic accident, and whether it's gated by size/time thresholds.
21. **Cross-thread interaction** — Rebellion × Ancients collisions in v1, or held as a v2 escalation tool.

Added by the advanced-manufacturing pass:

22. **Deuterium's identity** — the same resource as the Syndicate fuel utility's "Fuel," or a separate raw material.
23. **Lease dispute routing and venture relocatability** — legality-system integration, and how strong landlord leverage should be.
24. **Remaining recipes** — heavy ship classes, weapons, station modules, and Power Storage Units' full cross-asset role.
25. **Naming/institutional consistency** — ✅ _resolved_: there is a single top-tier institution, **the Syndicate**, consolidating the roles previously split between CHOAM and the Fuel Company (fuel utility, venture licensing, and the public market/exchange).

Added by the Syndicate consolidation pass:

26. **On-demand production pricing** — markup-on-market-price vs. summed component cost at current prices; the premium size and production delay; and the fallback when no market price exists for a never-produced good. The guiding principle is set: always a worse deal than a functioning player market, an escape valve rather than a competitor.
27. **Public transport terms** — ✅ _substantially resolved_ (Section 6): a real round-trip Shipment from the nearest Syndicate outpost, price realized on return, a flat percentage fee, narrow scope (goods sold to the Syndicate only), unlimited elastic fleet, and full exposure to interception via a high-defense hauler. **The doubled round-trip time is the primary premium**, not a tuned credit markup. What remains: the actual `feePercent` value, and hauler speed relative to player vehicles.
28. **Syndicate stake structure** — whether fuel-utility stakes and council shares/influence are one instrument or two tracks within the merged institution; whether the ~20–25% ownership cap now touches council voting power; and how to handle the raised stakes of coalition capture now that a single institution runs governance, licensing, fuel, and the market. **Sharpened by the universal-stake framing (Section 1):** if *every* guild holds a stake in the Syndicate by virtue of existing, that sits awkwardly beside Section 8's "guilds buy stakes." Either there's a **baseline stake granted by membership** that purchased stakes stack on top of (a floor, mirroring the baseline fuel allocation), or **membership and fuel-utility ownership are genuinely two separate instruments** and only the latter is bought. This needs deciding — it determines whether a brand-new guild arrives with a real, if small, vote.

Added by the galaxy-generation and architecture work:

29. **Planet archetypes and resource-node generation rules** — ✅ _resolved in design; implementation lost_ (Section 2, Section 16 status notes; Track G re-implements). Nine archetypes with weighted frequency; **archetype does constrain resources** (the recommendation, adopted); Terran and Oceanic carry guaranteed minimums; a galactic rare-tier ring gradient adds regional character. The **"Type A" convention is retired** — the answer to its own sub-question turned out to be that "type" *is* the physical archetype: Terran is Type A, and no separate resource-viability tier was needed. What remains open is narrower and split out as #33 below: `Planet.stats` (atmosphere/size/climate/biomes) is still unbuilt.
30. **Starter-eligible system tagging and seed validation** — ✅ _resolved in design; implementation lost_ (Section 13, Section 16 status notes; Track G re-implements). Tagging is "system has ≥1 Terran planet" — a clean derivation rather than a tuned threshold, since Terran's guarantee makes viability structural. The sector-spread guarantee is enforced *and* verified by the validation pass, which also checks resource-type reachability and the rare-tier proximity guarantee. Residual gap: validation does not yet check illegal claim overlap.
31. **Who should actually benefit from a fuel squeeze** — surfaced by the simulation (Section 8): a squeeze currently enriches an uninvolved steady producer *more* than the schemer who engineered it, while the intended victim suffers. Feature or problem? If a problem, the balancing lever is undecided. Also unresolved: whether the Manufacturer's shortfall should ever be survivable-but-degrading (the proposed survival floor, Section 8) rather than simply unmet demand. *(Addressed in principle 19-07-26: under the pooled-allocation model (§8) a big producer's big burn competes for a fixed pooled surplus and idle winnings buy less as the pool thins, so a windfall no longer compounds untouched. Whether that fully resolves the bystander-enrichment question needs the Phase 1 sandbox to show — the model isn't exercised until allocation is built.)*
32. **Resource node vs. mining slot naming** — ✅ _resolved_: the term is **resource node** everywhere, in this document and in code, matching what the seed generator already emits. "Mining slot" is retired.

Added by the planet-archetype and UI work:

33. **`Planet.stats`** — atmosphere, size, climate, and explicit biome data are still empty in the generator; archetype currently carries the whole economic load, and does so adequately. Open: whether stats are worth building at all, or whether archetype simply *is* the planet's identity and `stats` should be deleted from the entity rather than left as a permanently-empty object. The one thing that still wants them is Section 2's "planet profile biases disaster flavour" rule, which currently has no data to read.
34. **Wiring the System & Planet Index to real data** — `system_planet_ui_mockup.html` runs on one hardcoded demo system; connecting it to `seed.json` is unstarted. Related: `seed_viewer.html` doesn't render `archetype` or `ring` either, so *none* of the planet/resource/gradient work is currently visible in any client.
35. **The Index's main content area** — territory, tolls, and venture data have no UI design on either the system or planet view; both are empty-state placeholders.
36. **Art production pipeline** — 9 archetype images plus star art are planned (AI-generated), but production, storage, sizing conventions, and delivery into the client are unspecified. The CSS placeholders are built to be swapped one line at a time, so this is unblocked, not blocking.
37. **Terran self-sufficiency vs. the pull to expand** — surfaced by the Terran guarantee (Section 2): a guild that never leaves its homeworld has every resource in the game at low volume. Expansion pressure therefore has to come entirely from *scale and specialisation*, not scarcity of type. Whether that pressure is actually strong enough is untested, and won't be knowable until the Phase 1 economy runs.

**Sharpened, not resolved — #22 (Deuterium's identity).** The generator now emits `deuterium` as a raw `resourceType` on Oceanic planets, while Section 3 has raw Deuterium → *Processed* Deuterium Fuel, and Section 8's fuel utility trades "Fuel." That's consistent with two-things-with-one-name, but the code currently only knows about the raw one. Worth settling the vocabulary before the fuel utility is built, or the seam between generator and economy will be exactly the kind of gap Section 18 warns about.

Added by the Marketplace thread (merged 17-07-26):

38. **Salvage uniformity across Tier‑4 asset types** — does the −5% cut / 10% floor apply identically to structure-like assets (Toll Gate Kits, Factory Complexes) and actively-operated ones (ships, drones), or should they decay/salvage differently once the maintenance system exists?
39. **Condition decay mechanics** — undesigned. This thread fixed only how condition, once it exists, feeds salvage price; decay rate, causes (usage, time, combat/piracy exposure, neglect), and owner-facing surfacing are all open.
40. **On-demand production for non-asset goods** (#26) — the Tier‑4 commission mechanism is a plausible template; decide whether it's the *same* mechanism generalized or genuinely separate.
41. **Player listings below the salvage floor** — nothing stops a desperate guild undercutting the Syndicate's salvage price. Left open as consistent with pressure-over-prohibition; confirm that's the intended read rather than an oversight.

Added by the Phase 1 reconciliation (16/17-07-26) — these are the build-blocking subset; the full decision checklist with proposals lives in `docs/roadmap.md`, Phase 1:

42. **Posted-price semantics** — the proposed port rule (§8, §15.6): step 3 publishes the price governing the next action window. Reproduces the spreadsheet exactly; needs sign-off.
43. **Credit rounding under fractional prices** — §15.2 mandates integer credits; the simulator's are fractional. Proposal: every trade moves `round(qty × price)`, identical on both sides.
44. **Scarcity allocation when buys exceed the reserve** — the simulator only flags "OVER." Proposal: validate-as-they-arrive, whole order fails if short, deterministic bot order (an acknowledged fairness bias).
45. **Phase 1's second good** — tolls need traffic, and fuel shouldn't be it (Section 3). Option A (recommended): one raw good moves by shipment and pays tolls; Option B: fuel-only, with produced fuel physically shipped to the reserve. Undecided; blocks Stage 2.
46. **Land rent (the third territorial lever) in Phase 1** — assumed out of the widened scope (tolls and tariffs only); confirm.
47. **Phase 1 tuning numbers** — the invention table: influence economy, contest costs and window, disposition deltas/decay/cap, bot trading bands, toll and tariff defaults, transit ticks per edge, the player guild's start. Each needs a ruling or an accepted proposal before Stage 2; enumerated in roadmap.md.

Added by the fuel allocation & production model (19-07-26 — full model and its own open list in `docs/fuel-allocation-model.md`):

48. **Force-sell — keep or drop.** *Load-bearing, and a Phase 1 decision-checklist item.* The allocation model (§8) requires hoarding to be possible; the current port contract force-sells all production. Dropping it enables the withhold/hoard levers and the licence-premium anti-hoarding mechanism, but re-derives semantic #2 and the squeeze signature. Enforcement of *illegal* withholding is Phase 5; in Phase 1 dropping force-sell simply makes hoarding possible-and-expensive.
49. **The 1.1× route allocation multiplier** — confirm the 10% over-burn is an intended logistics subsidy (encourages movement), not an exploit surface; the licence quota guards against skim-only routes. 1.0× would make routes fuel-neutral.
50. **Marketplace coverage of the fuel benefit** — does Syndicate-facing fuel allocation extend to guild↔guild trades *routed through the Syndicate marketplace*, or only direct Syndicate/guild trades? Leaning toward the latter as a sharper lever.
51. **Quota-window fairness** — the licence pledge is checked over a window (24h placeholder); like the vote-window problem (#14), a guild that can't log in daily is punished. Window length interacts with tick rate and async play.
52. **Legitimate-dip grace** — a refinery knocked offline by a storyteller event shouldn't lose its licence discount on the same tick the event lands, or the event does double damage; a grace/ramp is needed.
53. **Geography-as-destiny** — the Syndicate-only benefit plus the regional-bloc counter-pull rewards guilds that start with good, clustered neighbours. Probably acceptable (asymmetry is design), but watch that a strong local cluster isn't a dominant opening once real play exists.

---

## 20. Agreed Next Steps *(refreshed 17-07-26)*

1. **Stand the repository up** — `github.com/Raven-git-hub/starfare`, structured per the README. Search the local machine for the missing artifacts (§16's list) and commit any that survive. From here on, two rules are policy: **no artifact leaves a session unsaved**, and **the document updates in the same commit as the code it describes.**
2. **Answer the Phase 1 decision checklist** (`docs/roadmap.md`) — Option A/B for the second good and the flagged proposals (#42–47). This is the only thing blocking Stage 2.
3. **Build Phase 1, Stage 2** — the test harness, then the walking skeleton, per `docs/prompts/phase-1-sandbox-prompt.md` and the Stage 1 plan.
4. **Track G, when wanted** — re-implement the galaxy layer against §2/§13/§16, verify the 15-07 figures (393/1,500 starter systems; ~41%/~3.6% rare-tier spread; repair pass firing zero times on seed 7331), then make it visible: render `archetype` and `ring` in the viewer (#34), and wire the Index UI to real seed data.
5. **Deferred but ready:** the fight-the-squeeze counter-play experiment (#31) in the existing simulator; the storyteller's signals and preset sketch; concrete Phase 2 architecture scoping (server loop, PostgreSQL schema for §15.4).
