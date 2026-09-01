# Points & Reputation — the size / contribution model (working design)

*Status: **design-in-progress**, captured 31-08-26 from the Points & Reputation design pass. This is the
**authoritative** source for Guild Points, Reputation-Point dynamics, and the fuel **mean line**. It
**consolidates and supersedes** the scattered reputation notes in `fuel-supply-and-allocation.md §2`,
`fuel-economy.md §2–4`, `venture-establishment.md §2.5`, and the reputation bullet in
`licence-and-price-system.md`. Where a number is unruled it is called `[FIRST-CUT]`, `[SHEET]` (needs a
spreadsheet/sim pass) or `[DEFERRED]` — never a silent constant. **§6 steps 1-2 are BUILT (31-08-26) apart from closure; everything else here is NOT.***

## 0a. What is BUILT *(31-08-26 — RP slices 1-2, the console readout **⏪ reverted 01-09-26**, GP slice 3, the mean line slice 4, fuel flows 5a, the founding endowment A′)*

Steps 1, 3 and 4 of §6 in full, and step 2 **apart from closure**. Read every other section of this doc as
design, not as code.

**⏪ The player Production Console shows none of this as of 01-09-26.** §6.1's Slice 1b readout was reverted;
the only rendering that survives is Slice 1c, the operator watcher's guild line in `client/inspect.html`. What
this section lists as BUILT is the ENGINE, and all of it still is: every field below is computed, serialized
where it is serialized, guarded, and published in the snapshot exactly as described. Only its display on
`/console` was withdrawn.

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
- **THE MEAN LINE (slice 4)** — `sim/meanline.js`, the join of the two halves above:
  - `expectedReputation(state, guild)` = `MEANLINE_K × guildPoints(...)`, an integer.
  - `issuanceModifier(state, guild)` = `clamp(1 + ISSUANCE_SENSITIVITY × gap / expected, FLOOR, CEIL)`, a
    float — one of the sanctioned non-integers, since it SCALES a quantity rather than being one. Unrounded on
    purpose: no precision is ruled, so a display formats it.
  - **The empty-guild guard** (`#7`): `expectedRP === 0 → 1.0` exactly, so nothing ever divides by zero and a
    guild holding nothing is trivially on its own line. `=== 0` is exact because GP — and therefore the
    expectation — is non-negative by construction.
  - **DERIVED, never stored**, like GP: no field, no serialized byte, no determinism hash.
  - **It READS and never writes** (§4): the licence layer authors RP, `sim/points.js` derives GP, and this
    module only judges one against the other.
  - **Snapshot** — `guilds[].expectedReputation` and `guilds[].issuanceModifier`. Additive; schema stays 7.
  - **Console** — both beside RP and GP in the Syndicate footer, the modifier sized and coloured as the payoff
    number.
- **THE FOUNDING ENDOWMENT (A′, §2.5)** — `guild.foundingEndowment`, a signed integer omitted from serialised
  state when 0, granted ONCE by the `foundGuild` apply (`sim/actions.js`):
  - sized by `foundingEndowmentFor(state, guild)` (`sim/meanline.js`) = `MEANLINE_K × systemPoints(...)` — the
    SYSTEM half of Points alone, so inline ventures are never endowed and every system claimed after founding
    raises the bar with nothing to cover it. **DERIVED**: it invents no number and tracks a retune of either
    `MEANLINE_K` or `W_SYS`.
  - `systemPoints` (`sim/points.js`) is new and is the system term `guildPoints` already computed, extracted so
    it exists once rather than in two spellings that could drift.
  - `checkGuildReputationSum` (`sim/invariants.js`) generalised to
    `guildReputation == Σ venture.reputation + foundingEndowment`; the endowment also joins the integer check.
    The tick's per-venture mover is UNCHANGED — the endowment is constant, so venture deltas keep the sum exact.
  - **Snapshot** — `guilds[].foundingEndowment`, echoed as stored. Additive; schema stays 7. The mean line and
    the modifier are untouched: they already read the TOTAL, which now carries the endowment inside it.
  - A bare-founded guild reads `issuanceModifier` **1.0** where it read the floor **0.30**. The console mirrors ONLY the two clamp bounds, to LABEL a pinned modifier, with a served-page
    tripwire; it deliberately does not carry `MEANLINE_K` or the slope, so it structurally cannot compute the
    modifier itself.
  - **CALIBRATION CONFIRMED, by test and in a browser.** The ruling's four claims for `k = 150` all hold on the
    engine's own numbers: a dense guild (1 system, 3 ventures at rest) reads **0.997**; the same three ventures
    sprawled over three systems read **0.330**; a just-expanded guild pins at **0.300**; a developed big guild
    (2 systems, 8 ventures) reads **1.160**. "Par" is about **three ventures per held system** — that one
    relation is what `k = 150` encodes, and density-beats-sprawl falls straight out of it.

**Explicitly NOT built, and nothing in the code approximates any of it:** the −500 **closure** and −300
**forced-lease** CONSEQUENCES — venture removal, licence revocation, the stakeholder offer; reaching −500 is a
**pin**, and a pinned venture keeps producing, keeps being judged, keeps being charged its fee, and can climb
back out at full strength. Also not built: the mean line / `expectedRP` / `MEANLINE_K` / the fuel issuance
modifier, `baseGrant`, every other RP source in §2.4, the `[DEFERRED]` GP sources of §1 (transports, tolls,
droids, outposts, exploration — and no field for any of them), and the client deploy-meter wiring (the
Establish-Venture panel's reputation copy is still mock — the engine is now the authority for the same
arithmetic, but nothing reads it yet).

**THE MODIFIER NOW HAS A CONSUMER** *(31-08-26 — fuel slice 5a, `fuel-supply-and-allocation.md` §2.1)*. It is
no longer published-and-unread: at every window boundary the Syndicate grants each guild
`round(BASE_GRANT_PER_GP × GP × modifier)` from a finite pool, so a guild's reputation-against-size decides how
much fuel actually arrives. `baseGrant` turned out to be **size-relative** — `BASE_GRANT_PER_GP × GP` — which
makes GP both the base AND the divisor inside the expected line, exactly §0's "draw sized by
reputation-against-size". The pool is finite and grants are **rationed proportionally** when it cannot cover
them, so the modifier decides a SHARE of a real commons rather than a number drawn from nowhere. What is still
unbuilt is the **price controller** (5b) that would pull draw back under supply. *(`MEANLINE_K = 150` now fixes the absolute scale
the GP weights are measured on, so those weights are no longer "relative only" in the sense of being
unanchored — but they and `k` remain a single `[FIRST-CUT]` system, and retuning one means retuning the
other.)*

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
This prevents "deploy traps" for any future passive asset, not just outposts. **⤳ Extended 01-09-26 (§2.6):** the venture **signing bump** now gives *productive* ventures a terms-scaled version of this same offset — 50% commitment lands a venture on its line, 100% above it — so "productive assets get no offset" is superseded: every venture gets an offset, sized by what it commits. **Its founding-time instance is the guild founding endowment (§2.5):** the home system a guild is granted at founding is exactly such an asset (raises GP, earns no RP), but because a founded guild has no venture to carry the offset — the starter gift is idle inventory — it lives as a one-time **guild-level** endowment rather than on the asset.

## 2. Reputation Points (RP) — contribution, VARIABLE, per-venture

A measure of how much a guild uses its size to contribute to the Syndicate. **Variable** — actions move it up
and down. **Per-venture running total; guild RP = Σ its ventures' RP** — plus a one-time **founding endowment** set at founding (§2.5), so the guild total is `Σ venture.reputation + foundingEndowment`.

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

### 2.5 The founding endowment — a new guild opens on its line (ruled 31-08-26, A′; **BUILT 31-08-26**)

**⤳ Numbers rescaled 01-09-26 (§2.6).** This section's worked figures (`150 × 12 = 1800`) are the OLD scale; post-rescale the same logic gives `1 × 200 = 200`. The mechanic is unchanged — a newborn opens exactly on its line — only the scale shrank.

**The problem the mean line creates for a newborn.** A just-founded guild holds only its **home system**
(GP `= W_SYS = 12`); the gifted starter assets are **idle inventory** (`phase-1-tuning.md` "Starter asset
gift") and score **0 GP** until deployed, and founding creates **no ventures**. So `expectedRP = MEANLINE_K ×
W_SYS = 150 × 12 = 1800` while `guildReputation = 0`, and the issuance modifier pins at the **floor (0.30)**.
A brand-new guild would be throttled to 30% fuel before it has had any chance to earn — punishing-for-ambition
aimed at exactly the moment we want players founding and expanding. The mean line cannot, on structure alone,
tell "just founded, hasn't had a chance" from "holds territory and does nothing with it": both read as
all-system-GP, zero-venture-RP.

**The ruling (A′).** Founding grants a one-time **guild founding endowment**: a signed-integer RP amount on the
guild, `guild.foundingEndowment`, set **once at founding** to `MEANLINE_K × (GP of the founding holdings)` —
which is `MEANLINE_K × W_SYS` (the home system is all a founded guild holds; idle starter assets score 0). A
guild's total reputation becomes

    guildReputation == Σ venture.reputation + guild.foundingEndowment

and `checkGuildReputationSum` (`sim/invariants.js`) generalises to include the term. So a newborn opens with
`RP = 1800 = expectedRP` → modifier **1.0**, exactly on its line. This is §1.2's passive-asset offset applied at
founding: the home system raises the bar but can never earn RP on its own, so it gets a one-time offset —
carried as a **guild-level** term rather than on the asset, because a founded guild has no venture to hold it
(the starter gift is idle inventory).

**Sizing is DERIVED — it invents no number.** `MEANLINE_K` (150) and `W_SYS` (12) are both already ruled; the
endowment is their product and **tracks them** if either retunes. It is NOT a tunable and gets no
`[FIRST-CUT]`/`[SHEET]` row (`phase-1-tuning.md` records it as derived).

**Density-beats-sprawl is preserved — the endowment neutralises the home base, once, and nothing else.**

- It is set **once at founding and never changes** — not recomputed, not added to on expansion.
- Every system grabbed **after** founding raises GP by `W_SYS` with **no** matching endowment, so sprawl still
  sinks a guild below its line — the anti-sprawl liability (§1, §3) is untouched.
- **Ventures earn their own bar** (§1.2: productive assets get no offset). **⤳ Superseded 01-09-26 (§2.6):** deployed ventures now DO get a terms-scaled signing bump (50% = on the line, 100% above). The founding *guild* endowment in this section is unchanged; what changed is that a signed venture is no longer minted at zero RP. A freshly-deployed venture — starter
  or later — raises GP and earns its RP back through commitments; the endowment does **not** seed ventures, so
  they run the normal lean-then-earn loop (§3). Deploying the starter miners/factories is still the gameplay,
  and each still climbs from ~floor to its line as it meets commitments.
- The GP formula and the confirmed `k = 150` calibration (§0a, §3) are **unchanged**: the endowment is purely
  **additive** and only newly-founded guilds carry it, so every established guild is judged exactly as
  calibrated.

**Intended consequence — rule it, don't "fix" it.** Because the endowment is permanent, a guild that dismantles
**all** its ventures but keeps its home system sits at `RP = foundingEndowment = 1800 = expectedRP` → modifier
**1.0**, NOT the floor. The home base is **permanently floor-protected**; only *extra* territory (sprawl) or
*un-earned* ventures pull a guild down. This is intended — your granted home is your guaranteed base. *(The
alternative of distributing the endowment onto starter ventures, so dismantling them dropped you to the floor,
was considered and rejected: it needs pre-deployed starter ventures, which the idle-inventory starter gift
rules out.)*

**Precedent.** The genesis home-claim already deliberately withholds the "+20 for an uncontested claim" earn
bonus (`sim/actions.js`: "that is for play actions, not founding"). Founding is already reputation-special; the
endowment is the same instinct — founding is **neutral**, not **earned**.

**Build seam — ✅ DONE 31-08-26, exactly as described.** `guild.foundingEndowment` is set in the `foundGuild`
apply (`sim/actions.js`), sized by `foundingEndowmentFor` (`sim/meanline.js`) off the new `systemPoints`
(`sim/points.js` — the system half of GP, extracted so the term exists once and the endowment tracks a `W_SYS`
retune exactly as `guildPoints` does); `checkGuildReputationSum` (`sim/invariants.js`) is generalised, and
`design.md §15.5` invariant 3 updated in the same commit. The mean line already reads `guild.guildReputation`
(the total) and needs no change. The empty-guild guard (§3: `GP = 0 → modifier 1.0`) is a **separate** case — a
guild holding literally nothing — and still stands; a founded guild has `GP = 12`, so the endowment, not the
guard, is what puts it on its line. `venture.reputation` is unchanged.

### 2.6 The rescale, the signing bump & the breach floor (ruled 01-09-26)

**The rescale — GP and RP on ONE small scale.** `MEANLINE_K` drops **150 → 1**, so a guild's expected RP now simply
*equals* its GP; the GP weights and the RP earn-rate shrink to match — held system `W_SYS` **12 → 200**, tier weights
**6/8 → 100/150** (spread widened to a deliberate **1 : 1.5 : 3 : 5** = 100/150/300/500, T3/T4 deferred), `REP_MEET_MAX`
**100 → 10**. Every value now sits in the low hundreds and GP and RP are the same size, legible at a glance. **This
changes no behaviour that matters:** the fuel modifier is `1 + SENS · gap/expected`, scale-invariant, so par, floor and
ceiling are exactly as calibrated — only the numbers shrank. The old 150 existed solely to lift RP into the thousands
while GP sat in the tens; with both on one scale it is redundant. Values in `phase-1-tuning.md`.

**Earn-rate scales with tier.** `metGain` gains a `tierFactor = W_TIER / 100` (T1 = 1 … T4 = 5), so a higher-tier
venture earns proportionally more RP per cycle. Every tier therefore breaks even in the same **~10 cycles**
(bar ÷ earn-rate), and the reward for climbing the manufacturing tree is bigger GP, bigger earning and a bigger
dividend — *not* a heavier bar to fill. Full-terms T1 = +10/cycle.

**The venture signing bump — §1.2's offset, generalised to productive ventures and scaled by terms.** §1.2 gave passive
assets a bar-neutral offset on deploy but held that *productive* ventures earn their bar from zero. This rescale replaces
that stance: **on signing a licence, a venture is minted with an instant RP bump `= 2 · committedOutputPct · (its GP
weight)`.**

- **0% commit → bump 0.** Adds GP with no RP → instantly below its line, throttled. Promise nothing, start behind.
- **50% commit → bump = 1× its GP.** Lands exactly on its line — bar-neutral. **This is the Syndicate's expectation:** it
  *expects* a venture negotiated at ~50%, and treats that as the neutral, on-the-line deal.
- **100% commit → bump = 2× its GP.** Launches its whole GP *above* the line — an instant fuel buff and a head start
  toward the dividend tier.
- Linear between.

The deploy slider is now the lever that sets whether a venture launches above, on, or below its line, and the fuel-credit
modifier moves with what the guild promises. The bump lives on `venture.reputation` at signing (so `checkGuildReputationSum`
covers it with **no** new term) and **supersedes** §2.5's "ventures earn their whole bar."

**Batch-deploy still stings, by design.** Deploying raises GP — and the bar — instantly. A 50%+ venture offsets its *own*
bar at signing, but a guild that batch-deploys many ventures at low commitment still opens a gap. That gap is the intended
"bitten off more than you've delivered on" pressure — only now it sits under the guild's control, via the terms it signs,
instead of being an unavoidable founding tax.

**The breach floor — lifted, not flipped.** The signing bump creates an exploit: sign 100% (grab the 2× bump and its
instant fuel buff), then never deliver — a 100%-commit breach costs almost nothing under the old floor. The fix is
deliberately **not** to make breach proportional to commitment: the Syndicate does **not** punish a guild that commits
maximally and only just falls short (maximum commitment already costs it all its delivered output), and high commitment
must stay attractive. Instead the **minimum** breach is lifted from 10% to **25% of `REP_BREACH_MAX`** (`REP_BREACH_MIN`
1 → 2.5 at the new scale), keeping the inverse-commitment curve but firming its cheapest end — cutting the
sign-then-breach free-boost tail from ~100 to ~34 cycles. The full undiscounted licence fee a breach already pays (in
credits, every cycle) is the rest of the deterrent. Whether 25% is enough is a `[FIRST-CUT]` playtest question.

**Deferred — the RP band.** The band bounds (−500 / 800 / 1500) and the gain taper are **left at their old-scale values**
by this rescale and flagged for their own ruling next (`phase-1-tuning.md`, RP-band deferral). Nothing halts, but the band
is loose at the new scale; rescaling it carries a global-vs-per-tier sub-choice the wide tier spread forces.

## 3. The mean line — expected RP for your GP (fuel issuance)

- **`expectedRP(GP) = MEANLINE_K × GP`. LINEAR** — the null hypothesis, and it matches "a guild of size X should
  have earned about this much." Convex/super-linear stays a later shape ruling if the big coast too easily.
- **`MEANLINE_K` is `[FIRST-CUT]` 150** *(was `[SHEET]`; ruled below and in `phase-1-tuning.md`, and the stale
  tag corrected 31-08-26 when slice 4 built it)*: calibrated so a **par** venture's *resting* RP ≈
  `MEANLINE_K × (its GP)` — in the units of the running-total band (−500..1500), **not** a per-cycle figure.
  *(The earlier per-cycle sketch — `k=5`, `met=+50` — is **retired**; it measured a quantity that no longer
  exists.)*
- **Issuance modifier:**

      gap      = guildRP − expectedRP(GP)
      modifier = clamp( 1 + ISSUANCE_SENSITIVITY × gap / expectedRP(GP), ISSUANCE_FLOOR, ISSUANCE_CEIL )
      fuelGranted = baseGrant × modifier        ← RULED slice 5a (fuel-supply §2.1): baseGrant = BASE_GRANT_PER_GP × GP

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

**Slice 1b — the operator/dev readout. ✅ LANDED 31-08-26 — ⏪ REVERTED 01-09-26.** *The guild-economy readout
does not belong on the player Production Console; it is deferred to the player-facing **Guild Hall** (see the
UNRULED list below, which already names it). `client/console.html` is restored to its pre-readout state; the
engine, the snapshot fields (`guildReputation`, `venture.reputation`, `guildPoints`, `expectedReputation`,
`issuanceModifier`, `fuelGrant`) and their tests are unchanged — only the console display and its served-page
tripwires were removed.*

**↳ WHY THIS RECORD STAYS.** The repo is the only memory (`CLAUDE.md`), so the slice is marked reverted rather
than deleted: a future session must not read a silent gap as "nobody has tried this" and build it again on the
same page. It also names what a Guild Hall slice inherits — the readout below is a working design for the
figures and their bounds, and the seven served-page tests it lost are the tripwires that slice will need to
write afresh, against its own markup. **What it was, kept verbatim as the historical record:** RP was rendered
where the met/breach verdict already lives — the Production Console's **Syndicate** tab, rebuilt on every
snapshot poll, so RP visibly moved as ticks advanced.

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

**Slice 1c — the operator panel's guild line. ✅ LANDED 01-09-26. `client/inspect.html` only.** The
god's-eye guild card's stats line drops the `influence` stub (still on the guild and in the snapshot, but
set once at founding and moved by no tick) and shows, per guild, **`GP`** (`guildPoints`), **`RP Δ`** —
`guildReputation − expectedReputation`, printed signed, teal when at or above the mean line and red when
below — and **`fuel/cyc`** (`fuelGrant.granted`, shown as `granted/desired` when `fuelGrant.rationed`, so a
clip is visible at a glance). Client-only: no engine, snapshot or schema change — all four fields were
already published (`snapshot.js`). Like Slice 1b, the browser computes no game number — the sole arithmetic
is the gap subtraction, because the engine publishes both sides of the mean line but not their difference.
This is the operator-view piece of the deferred UI wiring below; the player-facing questions stay unruled.

**⚠ UNRULED, and deliberately not decided here** — each needs a ruling before its code:

- The **player client** (`client/game.html`): whether the Establish-Venture deploy meter should stop mocking
  `repGain` and read the engine, and what a player-facing standing display (a "Guild Hall") shows at all. The
  engine is now the authority for the same arithmetic the meter draws, so the wiring is *possible*; whether the
  player should see a raw RP number, a band, or only a tier is a design question nobody has answered.
- What a player-facing readout should show **once closure exists**. (This was a live question for the
  console, where a pinned venture read PINNED; with Slice 1b reverted it is now the Guild Hall's to
  answer, and it stays unruled either way.)
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
   **✅ LANDED 31-08-26 — see §0a.** `sim/meanline.js`, derived and published; `MEANLINE_K` ruled 150 and its
   calibration confirmed against the engine. **It grants no fuel** — that needs `baseGrant`, step 5.
5. Then issuance, the reserve/flow price controller, the edges (`fuel-supply-and-allocation.md §8`).
   **✅ ISSUANCE LANDED 31-08-26 (slice 5a)** — the seeded pool, the abstracted influx and size-based grants
   with proportional rationing (`sim/issuance.js`). The **price controller is 5b** and is not built.

**Prerequisite for bot-testbed cycling: the renegotiation window (#64), §5.**
