# Transport & Routing — the model (design-ahead)

*Status: DESIGN-AHEAD. The **Syndicate tier** is built (the BUY engine, `sim/transport.js`,
`stepArrivals`, 29-08-26). The **guild tier** is Phase-4 and is specified here on paper before it
is built — the discipline is to name the shared primitives now so the guild tier is a superset of
the Syndicate one, not a rewrite. This file is the source of truth for the transport model; where it
refines §6/§8/§10 of `design.md`, it says so.*

---

## 1. Two tiers, one primitive

There are two kinds of transport, and they are deliberately different beasts:

- **Syndicate transport** is a *service* — the player does not plan it. A **single straight leg**,
  hex to hex, at a fixed speed, no tolls, no routing, no risk, no events. The Syndicate has its own
  ways. This is what BUY uses and the only tier built in Phase 1.
- **Guild transport** is a *player skill* — the player **routes** their own craft leg by leg through
  the toll network and open space, trading money, time and risk. Phase 4.

Both are built from the **same atom: the leg.** The Syndicate journey is a one-leg degenerate route;
a guild journey is a chain of legs. Everything below — length, ticks, position, the hex crossover —
is identical across tiers; the guild tier only *decorates* each leg (toll, owner, risk, per-craft
speed) and *chains* them.

## 2. The leg

A leg is a straight segment between two **hex anchors**, carrying:

- `startHex`, `endHex` — axial `{q,r}` coordinates. Anchors are always meaningful points: a
  waystation, a gate, a toll-outpost, a system, or an origin/destination. **Direction only changes at
  an anchor** — see gate-anchoring (§4).
- `departureTick`, `arrivalTick` — absolute ticks. The whole journey is a schedule of these; nothing
  is simulated per tick (§15.6 "a schedule is a prediction").
- (guild only) `isToll` (bool), the toll `owner`, and a `riskFactor` — see §4, §6.

### 2.1 Length — straight-line (Euclidean), not hex-step

> ⚠ **DOC↔CODE CONTRADICTION, TRACKED NOT RESOLVED (noted 31-08-26, fuel Slice 2).** This section rules
> Euclidean and calls hex-step "the wrong measure". The engine measures **hex-step**: `hexDistance` in
> `sim/transport.js` is the axial `(|dq| + |dr| + |dq+dr|) / 2`, and `nearestWaystation` returns it.
> Every live consumer therefore uses hex-step — `buyFromSyndicate`'s arrival tick, and now
> `routeFuelCost`'s burn. Slice 2 deliberately used whatever `nearestWaystation` already returned rather
> than picking a side, so burn and travel time stay derived from **one** geometry and cannot drift while
> the question is open. Resolving it is a ruling (which measure is right, and whether arrival ticks move),
> not a quiet code change — it is on the roadmap's decision checklist.


A craft that flies a straight line covers the **Euclidean distance between the two hex centres**, not
the count of hexes crossed. Convert each anchor to the plane and take the hypotenuse:

```
cart(q, r) = ( q + r/2,  r · √3/2 )      // adjacent hex centres come out exactly 1 apart
length     = | cart(endHex) − cart(startHex) |
```

This is a real number (fine — arrival ticks round it), and always ≤ the hex-step count. **Hex-step
distance is the wrong measure for straight flight** and is reserved for anything that genuinely acts
*per hex* — which, under gate-anchoring (§4), nothing in this model does.

### 2.2 Duration — the one function, parameterised for the future

```
legTicks(length, craftSpeed, isToll) = round( length × craftSpeed ÷ (isToll ? TOLL_BUFF : 1) )
```

- `craftSpeed` is **ticks per hex-unit for that craft** (§5). Higher = slower.
- `TOLL_BUFF = 2` (`[FIRST-CUT]`, flat) — a toll leg runs at 2× speed, so it takes half the ticks.
- The **Syndicate is the degenerate call**: `legTicks(length, SYNDICATE_SPEED, false)`. The guild tier
  passes a real per-craft speed and a real `isToll`. Same function, no rewrite — shaping it this way
  now is the whole point of doing the model on paper.

### 2.3 Position at any tick — and why it's free

Because speed is **constant along a leg**, the fraction elapsed *in time* equals the fraction covered
*in space*. So the continuous position is a plain interpolation — no integration, nothing stored:

```
f   = clamp01( (T − departureTick) / (arrivalTick − departureTick) )    // legProgress
pos = cart(startHex) + f × ( cart(endHex) − cart(startHex) )
```

`f` is the **legProgress** the UI and the storyteller both want (§6, §7). Storing just the two ticks
recovers the exact location at any moment.

### 2.4 The crossover — position back to a hex

To answer "what hex is the craft in right now?" (for events, or a map cell), invert the conversion and
snap to the nearest hex:

```
r_frac = pos.y / (√3/2)        q_frac = pos.x − r_frac/2
hex    = cubeRound(q_frac, r_frac)        // deterministic hex rounding (invariant 9)
```

`cubeRound` converts to cube coords, rounds all three, and fixes the axis with the largest rounding
error so they still sum to zero — deterministic on boundaries, which invariant 9 requires. The hex
returned is the one the **straight line actually passes through**, which need not lie on any hex-step
path — exactly right, because the craft is flying straight, not hopping centres.

## 3. The Syndicate tier (built)

A single leg: **nearest waystation → the destination system/outpost the player chose**, at the flat
`SYNDICATE_SPEED`, `isToll = false`, no risk, no events. Cash (and fuel-credits, §7) charged at
purchase; goods deposit on `arrivalTick`; destination lost in flight → the cargo vanishes (design.md
§6 "Syndicate Delivery"). This is `legTicks(euclideanLength, SYNDICATE_SPEED, false)` and nothing more.

## 4. The guild tier — gate-anchored routing on a graph (Phase 4)

**Routes are gate-anchored.** A craft may only change direction at a gate or a toll-outpost. That
turns the toll system into a **graph**: gates and toll-outposts are **nodes**, toll legs between them
are **edges**. A guild route is then: a short **open-space leg** from the origin to the nearest gate,
a **path through the toll graph**, and a short open-space leg from the last gate to the destination.
Routing is shortest-path over that graph against a cost function (money + time + risk); the hub case
(gate → toll-outpost → gate) is just a node of degree > 2 and falls out for free.

**Tolls** (refines §6's Toll Path):

- A toll is a guild-owned corridor, **≤ 10 hexes** (≤ 20 with a toll-outpost hub in the middle).
  Tolls are **local shortcuts**, so a long haul chains several, often owned by different guilds.
- **Charged per gate passed.** Owning a gate on a busy corridor is a passive income stream — a real
  business.
- A toll leg gives the **2× speed buff** (`TOLL_BUFF`) and lower risk; open-space legs are base speed
  and carry ordinary piracy exposure. **Nothing forces a craft onto the network** — open space is
  always legal, just slower, free, and riskier. That trade-off is the whole game of routing.
- **The 2× toll buff and the old "secured edge" speed bonus are the same mechanic** (unifies
  `phase-1-tuning.md`'s `[PROP]` "2 open / 1 secured ticks per edge"): the toll network *is* the fast,
  secured infrastructure. There is one speed knob — base off-network, 2× on-network — not two.
- **Syndicate craft never use tolls** — they fly straight and ignore the network entirely.

## 5. Craft & speed

Speed is a **property of the craft**, not a global constant, so `legTicks` takes it as an argument
(§2.2). Relative ordering (fastest → slowest), **numbers TBD** — a `[FIRST-CUT]` speed table when the
guild tier lands:

1. Ancient spycraft
2. Spycraft · Ancient light transport
3. Ancient medium transport · light transport
4. Medium transport
5. Heavy transport
6. Moving asset — a deployable (toll gate, outpost, deep-scan array) relocating to its site

Ancient variants outrun their normal counterparts; a deploying asset is the slowest thing on the map.
The **Syndicate hauler** is its own row (its speed is the `SYNDICATE_SPEED` we tune independently).
**Cargo capacity per craft is out of scope for the route model** (parked — it belongs to cargo
selection, not routing).

## 6. legProgress serves three consumers

The interpolation of §2.3 is read by three places, from one primitive:

- **The storyteller / events** (engine, §7) — affects state, so it is computed **in the engine,
  deterministically**.
- **The transport tab** and **the galaxy-map overlay** (client) — every active craft draws as a dot
  sliding along its leg. The client **re-derives** the smooth position between ticks for rendering
  (exactly as the clock ring animates off an engine-given period/phase); the engine exposes each
  active shipment's current leg endpoints and its two ticks, and the client tweens.

## 7. Piracy, risk, and interception (Phase 1: storyteller-only)

- **Phase-1 piracy is storyteller- and bot-driven only.** There is **no guild-initiated piracy** and
  no capture of craft or infrastructure. *(This deliberately simplifies §10's "human piracy is an
  emergent, attributable playstyle" for now; guild-run piracy / seizure is parked as a possible later
  **Resistance mission**, not built.)*
- Each leg carries a **`riskFactor`** — the storyteller's per-leg input, fed by a risk engine not yet
  built. Open space is riskier; toll legs are watched and safer (§4).
- **Interception outcomes are three: cargo loss, damage, and delay.** (No capture.) The change
  calculator (§15.6, deferred) resolves these against `riskFactor` at the leg boundary.

## 8. Fuel — the fuel-credit model (the tie-up)

*This resolves the "instant-SELL is free movement" tension flagged with the BUY commit (design.md §6),
and it is the **Phase-1 lightweight stand-in** for §8's allocation-as-purchasing-power — not a new
system. The full deuterium pool / refining machinery of §8 is explicitly **not built** here.*

**→ §8.0–8.1 (RULED 03-09-26) are the current authority for the Syndicate SELL/BUY transaction; the bullets immediately below are the original Phase-1 framing, kept for history and superseded where they differ.**

- **Doing business with the Syndicate costs fuel credits.** A guild spends a **fuel-credit allowance**
  to get a Syndicate trade done, so trading is not free — fuel still gates activity, exactly what §8's
  allocation model exists to ensure. This is why instant SELL does not undermine the fuel economy: the
  Syndicate collects in place, but you pay for that reach in fuel credits.
- **The allowance replenishes over time, proportional to the guild's reputation** — its contribution
  to the Syndicate. Good customers get more reach; this is §8's "refining contributors get priority"
  and "the benefit is Syndicate-facing" made into one legible number.
- Three playstyles fall out of the one mechanic: (1) grind **reputation** to earn more allowance; (2)
  spend money on **infrastructure** (tolls, outposts) to shorten your own routes to waystations and
  need less; (3) risk **illegal fuel refining** (§8: refining your own is always illegal, black-market
  fuel at the risk of a steep fine).
- **Relationship to §8 — the open ruling:** fuel-credits is a simplification of §8's full model. Does
  the full deuterium/pool/refining system later **subsume**, **replace**, or **coexist with** it?
  Deliberately open; the point of the Phase-1 stand-in is to make fuel *matter* without building that
  machinery yet. Whether SELL as well as BUY spends fuel credits, the per-transaction cost (flat vs
  distance-scaled), and the replenish formula are all open (§10).

### 8.0 The Syndicate transaction — RULED 03-09-26

The Phase-1 fuel-credit *allowance* above is the built **fuel hoard** (units), granted per cycle by
the reputation-driven issuance modifier (`fuel-supply-and-allocation.md` §2) and priced by the
controller (§4 there). A Syndicate trade spends that hoard to move goods, so fuel gates trading
exactly as this section intended — the mechanism is the hoard, not a separate allowance. The rulings
that make the SELL/BUY transaction concrete:

- **Both BUY and SELL burn route fuel — distance-scaled, from the hoard, in units.** A leg's burn is
  `routeFuelCost(system) = ceil(hexDistance(system → nearest waystation) × SYNDICATE_HAULER_BURN_RATE)`
  units (`SYNDICATE_HAULER_BURN_RATE = 0.5`; the function BUY already uses). **This closes §10 open #2's**
  "does SELL spend fuel / flat vs distance-scaled": **yes, and distance-scaled.** BUILT (SELL slice,
  03-09-26): `buyFromSyndicate` and `sellToSyndicate` both burn it now — `sellToSyndicate` sums
  `routeFuelCost(row.systemId).fuelBurn` across the basket and deducts the total from the hoard, refused
  whole when the hoard cannot cover the sum (`sim/actions.js`; the burn is priced at apply, the §8.1
  quote-lock being its own later slice).
- **Two pools, both monetary but separate.** Proceeds/cost are **credits** (the treasury); route fuel
  is **units** out of the **fuel hoard**, shown in credit-equivalent for the ledger only. A SELL is
  `+proceeds ¢ to treasury` and `−Σ fuelBurn units from the hoard`; a BUY is `−cost ¢` and
  `−Σ fuelBurn units`. Fuel is never paid from the treasury, nor credits from the hoard.
- **The guild always pays the one-way route.** SELL ships goods to the nearest waystation
  (system → waystation); BUY ships from the waystation to the destination the player picks
  (waystation → destination). Distance is symmetric, so the fuel is the same either way; only BUY
  carries a delivery lag (below).
- **A basket is one good across many systems (`allocations: [{systemId, qty}]`).** The transaction
  window's ADD button appends a row per system; the `sellToSyndicate` action already carries the array.
  Each row has its own nearest waystation and thus its own route fuel; the bill **compounds** across rows.
- **Reject-whole on the aggregate.** The whole order is refused if the hoard cannot cover the **summed**
  route fuel of every row (and, for BUY, if the treasury cannot cover the summed goods cost) — no partial
  fill, no shortened flight. Mirrors BUY's existing gate, applied to the basket total.
- **Settlement: SELL is immediate, BUY lags.** A SELL credits the treasury, burns the fuel, and removes
  the stock on confirm — the goods "reaching the waystation" is narrative, not a delay. A BUY debits
  credits and burns fuel on confirm, and the goods **arrive later** at
  `arrivalTickFor(tick, distance) = tick + ceil(distance × CRAFT_SPEED)` (`CRAFT_SPEED = 300` ticks/hex,
  a `[FIRST-CUT]`), landing via `stepArrivals` — already stamped on the shipment.

**BUILT (client, 03-09-26): the SELL & BUY finalise-transaction popups** (`client/game.html`, the TRADE
tab; mockups `docs/mockups/{sell,buy}-to-syndicate.html`). One `.est`-style overlay scoped under
`#tw-tx-overlay`, opened from the card's SELL/BUY buttons and rendering the right variant. **SELL** is a
basket carried in from the per-system allocation manifest — a fixed base row plus added rows (a system
dropdown over the systems that hold the good, a qty slider capped at `stockpilesBySystem[sys][good]`),
the two-pool ledger (Profit → treasury, Route Fuel Credits from the hoard), and confirm →
`sellToSyndicate`. **BUY** is a single order: the quantity fixed on the prior card, a destination dropdown
(the systems the guild holds, defaulting to the operating system; a disabled "controlled outpost — soon"),
the route fuel and a prominent **ARRIVAL TIME** `XXdXXh`, the cost/treasury/route ledger, and confirm →
`buyFromSyndicate`. **Every figure is read from the snapshot** — route fuel credits are
`fuelCost[sys].creditCost`, the arrival is `fuelCost[sys].travelTicks` formatted as a duration — with **no
geometry, burn rate, or craft speed on the client** (a served-page tripwire forbids all four tokens). The
reject-whole previews disable confirm on the **engine's own gates** (SELL: Σ `fuelBurn` > hoard; BUY:
`cost` > credits OR `fuelBurn` > hoard), and the success view reads the applied numbers back off the
returned snapshot. §8.1's quote-lock is **not** built here — the popups price at confirm. One field the
snapshot does not publish — the nearest waystation's *name* — is rendered generically ("Syndicate
waystation"), because naming it would need the "nearest" geometry the client must not compute.

**Naming (tracked, not resolved here):** the seed entity the code calls an `outpost` **is** the
Syndicate waystation (`nearestWaystation` iterates `getOutposts()`). The design word is *waystation*; a
future Guild-controlled *outpost* is a different thing (BUY-to-a-controlled-outpost is deferred until it
exists). The UI says "waystation"; a code rename of the seed `outpost` → `waystation` is its own tidy-up,
not part of the trade slices. (§2.1's Euclidean-vs-hex-step contradiction is untouched — the burn uses the
built `hexDistance`.)

### 8.1 The agreed-price quote — RULED 03-09-26 (its own slice, across SELL and BUY)

The price shown when the transaction window opens is the price the player trades at, honoured for a short
window — a firm **quote**, not a live-repricing feed. Only two numbers move (the resource **posted price**
every tick; the **fuel price** only at a cycle boundary); distances and fuel-unit burns are seed geometry
and never move, so the quote just freezes those two prices.

- **The engine owns the quote; the client never sends a price (§18).** The confirm action carries the
  **issue tick**, not a price. On confirm the engine re-derives the resource posted price and the fuel
  price **as they were at that tick**, from its own state/history, and applies them. The client cannot pin
  a favourable rate — it is not sending a rate, only a tick the engine validates.
- **The re-derivation source is a per-tick posted-price ring (RULED 04-09-26).** "Its own state/history"
  is made concrete here: the chart's price history (`sim/price-history.js`) samples only every 15 ticks —
  too coarse for a 5-tick quote — so the engine keeps a SEPARATE, engine-internal **per-tick ring of each
  good's posted price**, `QUOTE_TTL_TICKS + 1` = 6 deep (one slot per still-valid age, 0 through 5),
  serialized and updated each tick beside `recomputePrices`. On confirm the resource price is read straight
  from it at the issue tick; the **fuel price needs no ring** — the cycle-boundary expiry rule guarantees
  it has not moved, so the current fuel price already IS the issue-tick one. The ring is engine-internal,
  NOT a fourth chart tier (`fine` / `medium` / `coarse` are a published client contract).
- **`issueTick` defaults to the current tick.** Omitted ⇒ age 0 ⇒ prices at confirm, which is today's
  behaviour — so every existing caller and test is behaviourally unchanged, and only a client that sends a
  PAST `issueTick` gets the lock. Note the ring is always-on serialized state, so this slice MOVES the
  persisted-state goldens (re-pinned with justification) rather than being a byte-identical no-op; trade
  behaviour with `issueTick` omitted stays identical, and that equivalence is what the no-op proof shows.
- **Expiry — two rules, both required.** The quote is refused if the issue tick is more than
  **`QUOTE_TTL_TICKS` (`[FIRST-CUT]` = 5)** ticks old, **or** if a **cycle boundary** has passed since it
  was issued (the fuel price it agreed no longer exists). Past the window the transaction window shows an
  **expired** state and the player refreshes to re-quote at the current price.
- **Its own slice, over SELL and BUY both**, built *after* the core SELL transaction (which prices at
  confirm) closes the loop. Recorded here so it is not re-guessed.

## 9. The route planner (guild-tier UI, Phase 4)

The leg builder lets the player **see the whole journey's cost, time, and risk**, choose among routes,
and **save routes** for reuse — saved routes become the reusable trade lanes a guild invests in. Not
applicable to Syndicate transport (auto, single straight leg).

**Saved routes are plans, not guarantees.** A route runs through gates owned by other guilds; owners
change, gates are destroyed, tolls are raised. So a saved route must be **re-validated at launch**, and
**flagged whenever anything on it changes** — a real and fiddly complexity (acknowledged, not solved),
and the direct cousin of the Syndicate's destination-vanish rule.

## 10. Open questions (carry into the Phase-4 build)

1. The per-craft **speed table** numbers (§5) and where the Syndicate hauler and normal light
   transport sit.
2. **Fuel-credits ↔ §8**: subsume / replace / coexist, and the reputation→replenish formula (§8) — still
   open. *(RESOLVED 03-09-26, §8.0: SELL spends fuel too, and the cost is distance-scaled route fuel.)*
3. **Toll cost** through a hub — one toll or one per gate touched (leaning per-gate-passed).
4. **Route re-validation / change-flagging** mechanics (§9).
5. **Guild-run piracy / seizure** as a later Resistance mission (§7) — deferred, not designed.
6. `TOLL_BUFF` confirm at 2× flat; whether open-space legs keep any per-distance security modifier or
   it is purely binary (on-network 2× / off-network base).
