# Points & Reputation — the size / contribution model (working design)

*Status: **design-in-progress**, captured 31-08-26 from the Points & Reputation design pass. This is the
**authoritative** source for Guild Points, Reputation-Point dynamics, and the fuel **mean line**. It
**consolidates and supersedes** the scattered reputation notes in `fuel-supply-and-allocation.md §2`,
`fuel-economy.md §2–4`, `venture-establishment.md §2.5`, and the reputation bullet in
`licence-and-price-system.md`. Where a number is unruled it is called `[FIRST-CUT]`, `[SHEET]` (needs a
spreadsheet/sim pass) or `[DEFERRED]` — never a silent constant. **§6 steps 1-2 are BUILT (31-08-26) apart from closure; everything else here is NOT.***

## 0a. What is BUILT *(31-08-26 — RP slices 1 and 2, the console readout, and GP slice 3)*

Steps 1 and 3 of §6 in full, step 2 **apart from closure**, and the §6.1 dev readout. Read every other
section of this doc as design, not as code.

- **`venture.reputation`** — a signed integer on the venture, omitted from serialized state when `0`,
  non-negativity-exempt (`design.md` §15.5 invariant 3), non-conserved. `sim/state.js`.
- **`guild.guildReputation`** — the same signed integer, `Σ` its ventures'. **Denormalised and guarded**, not
  derived: the ventures are the source of truth, the guild field is the cached sum, moved in the same place and
  by the same delta, and asserted every tick by `checkGuildReputationSum` (`sim/invariants.js`). *Chosen over
  deriving it because the field is already present on every guild in every save and every pinned determinism
  golden — deriving would move all of those hashes to buy a purity a tripwire delivers more cheaply, and it is
  the bargain `homeSystemId` and `venture.systemId` already run under.*
- **The meet/breach movement at the window boundary** — `sim/tick.js`, in the same per-licensed-venture loop
  that already resolves `status` for the licence fee, reusing that exact verdict so the fee and the reputation
  event can never disagree. Once per licensed venture per boundary.
- **The §2.2 band arithmetic (slice 2)** — `sim/licence.js`, which owns it per §4. Slice 1's flat `[FIRST-CUT]`
  ±20/−30 placeholders are **gone**, not deprecated:
  - `metGain(venture)` = `REP_MEET_MAX · (REP_W_COMMIT · commit + REP_W_EQUITY · equityFrac)` — terms-scaled,
    the deploy meter made real. `equityFrac` reuses `normalisedTerms`' `oNorm`, so the RP meter and the fee
    grid cannot come to disagree about what "offered equity" normalises to.
  - `breachPenalty(venture)` = `−(REP_BREACH_MAX − (REP_BREACH_MAX − REP_BREACH_MIN) · commit)` — linear,
    inverse to commitment, and independent of equity.
  - `gainFactor(rp)` — the §2.3 taper, applied to **gains only**. Drops land at full strength at every height.
  - The **floor is a hard clamp** in the tick; the **cap is not clamped at all** — the taper rounds a gain to
    zero before 1500 is reached (the largest possible gain lands its last unit at **1497**), which is what §2.3
    means by an organic soft cap. `guild.guildReputation` moves by the **actual post-clamp change**, so
    `checkGuildReputationSum` stays exact when a venture pins at the floor.
  - A verdict worth a **zero net change writes nothing** — a 0%-commitment licence (always met, zero terms,
    zero gain), a venture already pinned at the floor, or one at the taper's asymptote. So `venture.reputation`
    is minted by the first verdict that MOVES it, and a 0%-floor licence adds not one byte of reputation to the
    galaxy however long it runs.
- **`checkReputationBand`** (`sim/invariants.js`) — every venture's RP sits in `[−500, 1500]`. It is the only
  thing guarding the TOP, since no line of code enforces the cap directly.
- **Snapshot** — `guilds[].guildReputation` and `ventures[].reputation`, echoed as stored (the engine decides,
  the browser renders). Additive; schema stays 7.
- **GUILD POINTS (slice 3)** — `sim/points.js`, the whole of §1.0:
  - `guildPoints(state, guild)` = `W_SYS · heldSystemIds(state, guild.id).length + Σ ventures W_TIER(tier)`,
    an integer. Weights `[FIRST-CUT]` **12 / 6 / 8** in `phase-1-tuning.md`, **relative only**.
  - `tierOf(good)` reads the resources vocabulary through its own predicates — raw → 1, processed → 2 — so
    mining and refining are not special-cased and a higher tier lights up by adding one line to `TIER_WEIGHT`.
  - **DERIVED, never stored.** No `guild.guildPoints` field, nothing serialized, nothing in any determinism
    hash — so the state goldens are byte-identical by construction rather than by re-pinning. Pure: computing
    it moves no byte.
  - **Ventures, not assets** (a venture IS its deployed asset, so idle inventory scores nothing and no machine
    is counted twice); **empty held systems still count `W_SYS`** (the anti-sprawl liability, §2).
  - **An unweighted tier HALTS**, naming the good, the venture, the guild and where to rule the weight.
    Scoring it 0 would understate a guild's size and quietly lower the bar its reputation is judged against.
    Unreachable today — a test asserts every mining resource and every recipe output has a ruled weight.
  - **Snapshot** — `guilds[].guildPoints`, computed by that helper. Additive; schema stays 7.
  - **Console** — the number beside reputation in the Syndicate footer. No gauge: GP is unbounded, so a bar
    would need an invented maximum. The browser weighs nothing and holds no Points constant.

**Explicitly NOT built, and nothing in the code approximates any of it:** the −500 **closure** and −300
**forced-lease** CONSEQUENCES — venture removal, licence revocation, the stakeholder offer; reaching −500 is a
**pin**, and a pinned venture keeps producing, keeps being judged, keeps being charged its fee, and can climb
back out at full strength. Also not built: the mean line / `expectedRP` / `MEANLINE_K` / the fuel issuance
modifier, `baseGrant`, every other RP source in §2.4, the `[DEFERRED]` GP sources of §1 (transports, tolls,
droids, outposts, exploration — and no field for any of them), and the client deploy-meter wiring (the
Establish-Venture panel's reputation copy is still mock — the engine is now the authority for the same
arithmetic, but nothing reads it yet).

**GP IS PUBLISHED WITH NO CONSUMER.** Slice 3 computes and shows it; nothing reads it to decide anything. The
mean line that judges RP against it (`expectedRP = MEANLINE_K × GP`, §3) is the next slice, and `MEANLINE_K` is
still `[SHEET]` — which is also why the GP weights are ruled *relative only*: nothing fixes their absolute
scale until that constant does.

**Deliberately not this cut:** the met gain is **not window-pro-rated**. A mid-window joiner's first window is
pro-rated for its target and its fee (`windowFraction`) but not for its reputation, so it earns a full cycle's
gain for a partial cycle met.

**Where the constants live — RESOLVED.** Slice 1 flagged a deviation: its build prompt put the magnitudes in
`sim/fuel.js`, and they went in `sim/licence.js` instead because §4 rules that the licence layer owns how RP
moves. The slice-2 prompt confirms that placement in its own words ("constants live in `sim/licence.js` (§4
ownership)"), so the question is closed and every RP constant lives there beside `feeOwed`.

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

### 1.0 The formula (ruled 31-08-26 — slice 3)

    GP(guild) = W_SYS · (held systems) + Σ ventures W_TIER( tier of producedGoodFor(venture) )

**DERIVED, not stored (ruled).** GP is a pure function of *current* holdings, so it is a helper recomputed
on read (like `heldSystemIds`), exposed in the snapshot, and **never serialized into state** — the
determinism goldens stay byte-identical by construction, nothing to re-pin. There is no `guild.guildPoints`
field.

**Count ventures, not assets — idle = 0 (ruled).** A venture *is* its deployed asset (it names the `assetId`
it runs on), so ventures are counted and idle inventory scores nothing; counting deployed assets *and*
ventures would double-count the same machine. This **supersedes** the "deployed assets" source line above as
a separate entry.

**Empty held systems still count `W_SYS` (ruled).** Territory raises the bar whether or not it is developed
— the anti-sprawl liability (§2's density-beats-sprawl): a held system with no ventures is pure GP with no
reputation to pay it back.

**Tier is general, via `producedGoodFor`** (raw → T1, processed → T2, …): mining and refining fall out
today, and higher weights `W_T3`/`W_T4` light up automatically when those goods are real. Weights are
`[FIRST-CUT]` in `phase-1-tuning.md`, **relative only** — slice 4's `MEANLINE_K` sets the absolute scale, so
what matters is the ratio (systems Points-heavy, ventures Points-light, higher tier a notch above lower). GP
is an integer.

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

**Slice-2 arithmetic (ruled `[FIRST-CUT]`; magnitudes in `phase-1-tuning.md`).** The met gain is the deploy
meter made real (terms-scaled), scaled by the §2.3 taper before it lands and — first cut — **not**
window-pro-rated. The breach drop is **linear** inverse-commitment and is **not** tapered. RP is
**hard-clamped to the band**: a breach cannot push it below −500 (the venture pins at the closure threshold,
awaiting the closure slice), while the taper holds the top; `guild.guildReputation` moves by the *actual*
post-clamp change, so `checkGuildReputationSum` stays exact. The −500 / −300 closure *consequences* are a
separate later slice.

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

**Ruled `[FIRST-CUT]` for slice 4 (numbers in `phase-1-tuning.md`; calibrated by model, not guessed):**
`MEANLINE_K = 150`, `ISSUANCE_SENSITIVITY = 1.5`, `ISSUANCE_FLOOR = 0.3`, `ISSUANCE_CEIL = 1.5`. The floor
and slope carry the **punishing-for-ambition** lean (31-08-26): a guild that expands its holdings faster
than its reputation can back them up is thrown toward the floor and stays there until its RP climbs, while a
guild that has *earned* its size sits on or above its line untouched. The asymmetry (floor 0.3 vs ceil 1.5)
means falling below the line hurts more than rising above it helps. **Expansion is deliberately lean until
backed by reputation** — a just-grabbed system or a freshly-deployed venture raises `expectedRP` at once
(GP jumps) while the RP has not been earned, so the guild draws ~floor for the ~20 cycles it takes to climb;
the floor and the starter fuel hoard are the safety net (no death spiral). **The modifier is DERIVED and
watchable, and grants no fuel yet** — `fuelGranted = baseGrant × modifier` needs `baseGrant`, the pool/price
slice (§8). This slice computes and shows the modifier; nothing consumes it.

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

## 6.1 UI wiring — where RP is actually shown

*Added 31-08-26, **by the dev-panel build**, not ahead of it. ⚠ The build prompt for that slice cited a "§6.1"
that did not exist: the doc had no UI-wiring plan at all. Rather than build against a ruling that was not there
and leave no trace (`CLAUDE.md`: "the repo is the only memory"), this section records what was BUILT and marks
everything else as **unruled** — it is a record, not a design pass. The same thing happened once before, with
fuel Slice 1's citation of a `fuel-supply-and-allocation.md §1.3` that landed later; see the roadmap.*

**Slice 1b — the operator/dev readout. ✅ LANDED 31-08-26. `client/console.html` only.** RP is rendered where
the met/breach verdict already lives: the Production Console's **Syndicate** tab, which is rebuilt on every
snapshot poll, so RP visibly moves as ticks advance.

- **Per venture** (roster rows, for any venture under a licence): its `reputation` as a number, plus a compact
  band gauge. A venture at the floor is labelled **PINNED** — never "closed".
- **Per guild** (panel footer, beside the guild-wide fee lump it matches in scope and cadence):
  `guild.guildReputation` with a full gauge and printed scale.
- **The gauge** spans `RP_FLOOR`…`RP_SOFT_CAP` with the taper zone shaded and marks at −500, −300, 800, 1000.
- **The browser computes NO game number.** Both figures are echoed off the snapshot; the guild total is *not*
  re-summed from the venture rows (the engine owns that sum and guards it every tick). The only arithmetic is a
  bar position, `(value − floor) / (cap − floor)` — presentation over engine-owned bounds.
- **Constants:** the three band bounds are MIRRORED from `sim/licence.js` with a served-page tripwire, the
  repo's existing convention for engine constants the client needs. The two **tier marks** (−300, +1000) have
  **no engine constant to mirror** — nothing in `sim/` names them, because neither consequence is built — so
  they are pinned against the ruling in §2.1 instead, and labelled "not built" on screen.

**⚠ UNRULED, and deliberately not decided here** — each needs a ruling before its code:

- The **player client** (`client/game.html`): whether the Establish-Venture deploy meter should stop mocking
  `repGain` and read the engine, and what a player-facing standing display (a "Guild Hall") shows at all. The
  engine is now the authority for the same arithmetic the meter draws, so the wiring is *possible*; whether the
  player should see a raw RP number, a band, or only a tier is a design question nobody has answered.
- What the console should show **once closure exists** — a pinned venture currently just reads PINNED.
- Whether the **−300 / +1000** tiers should become engine constants. Today they are doc-only marks on a scale.

## 6. Build order

1. **RP field + meet/breach (slice 1). ✅ LANDED 31-08-26 — see §0a.** Create `venture.reputation`, sum into
   `guild.guildReputation`, wire a **flat** `[FIRST-CUT]` meet-gain / breach-drop at the window boundary, expose
   in the snapshot. Makes RP a live, moving, visible number. *(Band shaping and the mean line come after — flat
   magnitudes here are placeholders to make it move, like `GUILD_STARTING_FUEL` was.)*
2. **Band shaping** (the licence reputation slice): the taper (§2.3), inverse-commitment breach (§2.2), closure
   at −500, and the calibrated magnitudes. Reconciles the `§5/§7` tiers.
   **✅ MOSTLY LANDED 31-08-26 (RP slice 2) — see §0a.** The taper, the terms-scaled meet, the
   inverse-commitment breach and the band clamp are built. **CLOSURE IS NOT**: −500 is a pin, and what happens
   at −500 / −300 is a slice of its own, still to come.
3. **GP calculator** — systems + mining + refining + deployed assets, tier-scaled (§1).
   **✅ LANDED 31-08-26 — see §0a and §1.0.** Derived, never stored; tier via `producedGoodFor`, so it is
   general rather than a mining/refining special case. *(The "deployed assets" in this line is superseded by
   §1.0's count-ventures-not-assets ruling: a venture IS its deployed asset.)*
4. **The mean line + fuel modifier** (§3) — needs `MEANLINE_K` from a sheet pass.
5. Then issuance, the reserve/flow price controller, the edges (`fuel-supply-and-allocation.md §8`).

**Prerequisite for bot-testbed cycling: the renegotiation window (#64), §5.**
