# Points & Reputation — the size / contribution model (working design)

*Status: **design-in-progress**, captured 31-08-26 from the Points & Reputation design pass. This is the
**authoritative** source for Guild Points, Reputation-Point dynamics, and the fuel **mean line**. It
**consolidates and supersedes** the scattered reputation notes in `fuel-supply-and-allocation.md §2`,
`fuel-economy.md §2–4`, `venture-establishment.md §2.5`, and the reputation bullet in
`licence-and-price-system.md`. Where a number is unruled it is called `[FIRST-CUT]`, `[SHEET]` (needs a
spreadsheet/sim pass) or `[DEFERRED]` — never a silent constant. **Not built.***

## 0. The one-line frame

Two scores decide a guild's fuel issuance:

- **Guild Points (GP)** — *how big you are.* A tally of everything you own and have **deployed**. Fixed.
- **Reputation Points (RP)** — *how much you use that size to contribute to the Syndicate.* Variable.

**Fuel issuance = your RP judged against the RP expected for your GP.** Bigger guilds are held to a higher
standard (more GP → higher expected RP), so size alone earns nothing — it raises the bar you must clear by
contributing. This is "the storyteller targets the comfortable" as pure economics.

## 1. Guild Points (GP) — size, FIXED

A points tally of a guild's holdings. **Fixed** — it changes *only* when assets, ventures or systems enter or
leave possession. Recomputed each tick from state, never accumulated.

- **Deployed only. Idle = 0.** An asset sitting in inventory scores nothing; deployed onto a resource node, or
  producing a tiered item, it scores. Deploying stuff is what grows GP.
- **Higher tiers score more.** A higher-tier producer is worth more GP than a tier-1 miner. Transports score by
  **size** (larger = more).
- **Sources countable TODAY** (repo reality, `a96fcb8`): **systems held** (`sim/claims.js`), **mining
  ventures**, **refining ventures**, **deployed assets** (`sim/assets.js`). Tier-scaled.
- **`[DEFERRED]` sources — named so Claude Code does NOT invent fields.** Not built; wire in when their systems
  land: **transports** (size-scaled), **tolls**, **droids**, **outposts** (guild-owned — see naming below),
  **exploration**. Do **not** add `guild.tolls`, `guild.scanners`, etc.

### 1.1 Outpost vs Waystation (naming — resolved)

- **WAYSTATION** = a **Syndicate-owned** trading entity (the 9 waystations, `sim/transport.js`). **Not** guild
  GP. Do not count Syndicate infrastructure as a guild's size.
- **OUTPOST** = a **guild-owned** deployable asset. Worth GP **and** a small **RP bump on deploy** (§2.4).

### 1.2 The passive-asset offset principle (why the outpost gets RP on deploy)

An outpost raises your GP (your bar) but delivers nothing to the Syndicate on its own — so with no RP, deploying
it would drop you *below* your line and **punish** you for deploying a useful asset. The fix: **any GP asset
that can't earn RP through use gets a one-time deploy RP bump ≈ `MEANLINE_K × (its GP)`, so deploying it is
bar-neutral.** Productive assets (mines, refineries) get **no** offset — they earn their bar back by delivering.
This prevents "deploy traps" for any future passive asset, not just outposts.

## 2. Reputation Points (RP) — contribution, VARIABLE, per-venture

A measure of how much a guild uses its size to contribute to the Syndicate. **Variable** — actions move it up
and down. **Per-venture running total; guild RP = Σ its ventures' RP.**

- **Fields:** a new per-venture `venture.reputation` (greenfield — `sim/state.js` currently omits it), summed
  into the **existing** `guild.guildReputation` (present at `sim/state.js:81`, initialised `0`, currently
  written by nothing). Signed **integer** (§15.2), **non-negativity-exempt** like `credits` (a venture in bad
  standing is a pressure state, not a broken ledger). Guild RP is the **sum** — one source of truth (derive it
  from the ventures, or keep it denormalised with a sum-consistency tripwire; follow the repo convention).
- **You do NOT earn RP for owning a venture. You earn it for consistently meeting commitments.**

### 2.1 The band: −500 to approximately 1500

    1500 ┬──── organic soft cap (approximately — asymptotic; a hard-won buffer above dividend-max)
    1000 ┼──── dividend-max tier (licence layer: 10 tiers, each +10% dividend)
         │
      RP │        the operating range
         │
    −500 ┴──── closure floor (venture closed, licence revoked) — reached only by breaching

**The band edges ARE the licence layer's reputation tiers** (`licence-and-price-system.md §5/§7`: +1000
dividend-max, −300 forced-lease, −500 closure). The fuel model and the licence model share **one** RP on **one**
scale, by construction — not two reputations. RP can climb past +1000 toward approximately 1500 to bank a buffer
(§2.3).

### 2.2 Two outcomes a cycle (commitment is locked mid-contract)

A licensed venture's commitment is **locked for the contract term** — mid-contract there is no "idle" state;
every cycle is exactly one of two:

- **MEET → +gain**, sized by the licence **terms** (commitment % + offered equity). The deploy panel's **0–100
  meter is this gain, realised on delivery** — *not* a grant for signing. **Signing itself = 0.**
- **BREACH → −drop**, **linear**, and **inverse to commitment**: breaching a *small* commitment hurts **more**
  than breaching a large one (breaking a token promise is contempt; falling short of an ambitious one is
  forgivable). Excludes 0% (no obligation, no breach). Can drive RP to −500 = closure.

Breaching a high commitment is **RP-cheap but fee-expensive** (full fee on breach) and risks closure — the
discipline lives in credits and closure, not in the RP penalty. *Let the player play how they like.*

### 2.3 The gain taper (approaching the cap)

- **Below 800:** gains at full strength.
- **800 → 1500:** gains **taper** — `gainFactor = clamp((1500 − RP) / 700, 0, 1)` → 1.0 at 800, 0.5 at 1150, 0
  at 1500. `1500` is an **organic soft cap** (approached, never really passed).
- **Drops stay linear everywhere**, including above 800. So the top of the band is **slow to climb, fast to
  fall** — a hard-won, fragile buffer. (This is the "high-standing bank a buffer they're tempted to gamble"
  theme, falling straight out of the curve shape.)
- A recovering (negative) venture climbs at **full strength** — the taper bites only above 800 — so a
  redemption arc from the closure zone is achievable.

**Runaway is bounded organically, no hard cap.** Each venture asymptotes near +1000 (soft cap 1500), so guild RP
≤ approximately `n × 1500` while GP also scales with venture count `n` — the ratio the mean line reads stays sane
no matter how big the guild grows.

### 2.4 Positive / negative RP sources

**Built spine (slice 1 wires this):** licence **MEET (+) / BREACH (−)** per venture, at the window boundary
(already computed as `status` in `sim/tick.js`; invariant 8 / rule #61 reserves it).

**`[DEFERRED]` additional sources — wire in when built:**

- Positive: high commitment + high offered equity at application (the **>50** half of the meter); high
  proportion of credits **invested in other ventures**; **leasing transports** to the Syndicate (idle transport
  is **not** a negative); the **outpost deploy offset** (§1.2).
- Negative: low commitment + low offered equity (the **<50** half); **zero** investment in other ventures.

**Neutral (ruled 0):** signing a licence (`applyForLicence`); buying from the Syndicate (`buyFromSyndicate`) — a
pure consumer sinks by earning nothing against its bar, so buying needs no explicit penalty.

## 3. The mean line — expected RP for your GP (fuel issuance)

- **`expectedRP(GP) = MEANLINE_K × GP`. LINEAR** — the null hypothesis, and it matches "a guild of size X should
  have earned about this much." Convex/super-linear stays a later shape ruling if the big coast too easily.
- **`MEANLINE_K` is `[SHEET]`:** calibrate it so a **par** venture's *resting* RP ≈ `MEANLINE_K × (its GP)` — in
  the units of the running-total band (−500..1500), **not** a per-cycle figure. *(The earlier per-cycle sketch —
  `k=5`, `met=+50` — is **retired**; it measured a quantity that no longer exists.)*
- **Issuance modifier:**

      gap      = guildRP − expectedRP(GP)
      modifier = clamp( 1 + ISSUANCE_SENSITIVITY × gap / expectedRP(GP), ISSUANCE_FLOOR, ISSUANCE_CEIL )
      fuelGranted = baseGrant × modifier        ← baseGrant is the pool/price slice, later

  Ratio-based (`gap / expected`) → **scale-invariant**. **FLOOR** stops a below-line guild death-spiralling to
  zero; **CEIL** protects the finite pool at the crunch edge.
- **Empty-guild guard (`#7`):** `GP = 0 → expectedRP = 0` and `gap / expected` divides by zero. **Ruling:
  `expectedRP == 0` → modifier = `1.0`.** Correct: a guild holding nothing is on its own line, draws the neutral
  `baseGrant`, and no new-guild death spiral opens.
- **CEIL saturation is a FEATURE:** when many guilds sit well above their lines (universal cooperation) the buff
  saturates and **price** becomes the real throttle — `fuel-economy.md §2`'s flat-high-price equilibrium.

## 4. Ownership & seams (who owns what)

**One reputation, two owners of two different jobs:**

- The **LICENCE LAYER owns how RP MOVES** — the band, meet/breach, the taper, the tiers, the escalating closure.
  This is **#61** / the licence reputation slice (`licence-and-price-system.md §5/§7`, Slice 4).
- The **FUEL LAYER owns GP, the mean line, and the issuance modifier.** It **reads** `guild.guildReputation`; it
  does **not** author it.
- The invented `guild.reputation` from the earlier fuel draft is **WITHDRAWN** — use the existing
  `guild.guildReputation` (the guild sum) plus the new per-venture `venture.reputation`.

## 5. Deferrals, dependencies & to-dos

- **Parking → the renegotiation window (#64).** A venture can only drop or reduce its commitment at contract
  **renewal** (commitment is locked mid-contract), so the "park at high RP and coast" move is **impossible until
  the renegotiation window is built** (it is currently inert). Its fix lives **there**, not in an RP decay:
  - **Carrot:** a high-RP venture is offered renewal on **better terms** (reputation earns a better *deal*).
  - **Stick:** attempting to slash commitment / walk at renewal triggers a **standing penalty**.
- **⚠ TO-DO / PREREQUISITE (add to `roadmap.md`): the renegotiation window (#64) must be built BEFORE this model
  can be cycled through a bot testbed.** Without it contracts never turn over, so the renew-or-lose-standing
  maintenance loop never runs and bots can't exercise the full RP lifecycle.
- **`[DEFERRED]` GP sources (§1) and RP sources (§2.4)** wire in as their systems land.
- **Numbers:** all live in `docs/phase-1-tuning.md`. `MEANLINE_K` and the meet/breach magnitudes are `[SHEET]`
  (calibrate against the band once a "par" venture's resting RP is known — do **not** invent the escalation
  curve here); the taper knee/cap and the issuance clamp are `[FIRST-CUT]`.

## 6. Build order

1. **RP field + meet/breach (slice 1).** Create `venture.reputation`, sum into `guild.guildReputation`, wire a
   **flat** `[FIRST-CUT]` meet-gain / breach-drop at the window boundary, expose in the snapshot. Makes RP a
   live, moving, visible number. *(Band shaping and the mean line come after — flat magnitudes here are
   placeholders to make it move, like `GUILD_STARTING_FUEL` was.)*
2. **Band shaping** (the licence reputation slice): the taper (§2.3), inverse-commitment breach (§2.2), closure
   at −500, and the calibrated magnitudes. Reconciles the `§5/§7` tiers.
3. **GP calculator** — systems + mining + refining + deployed assets, tier-scaled (§1).
4. **The mean line + fuel modifier** (§3) — needs `MEANLINE_K` from a sheet pass.
5. Then issuance, the reserve/flow price controller, the edges (`fuel-supply-and-allocation.md §8`).

**Prerequisite for bot-testbed cycling: the renegotiation window (#64), §5.**
