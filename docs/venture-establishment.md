# Starfare — Venture Establishment panel: design record & data-point catalogue

Design record for the **venture-establishment page** — the popup a player uses to stand up a
venture. Companion to `design.md §4` (assets/ventures/droids) and `§5` (the licence fee, breach,
leasing) and to `console-client-and-art.md` (the Archive visual system + the console it sits beside).
On DESIGN, `design.md` wins; this doc adds the panel's flow and its **data-point catalogue** for
growing the live galaxy-state model.

Working mockup: `docs/mockups/venture-establishment.html` (Archive style; titanium tier-1 FUE, with
the factory/slot path generalised). Every number in it is `[FIRST-CUT]` → checklist #56/#63/#64; the
whole licence economy, reputation, and renegotiation are **design-ahead** (not in the engine —
`design.md §5 ~line 337`). *(Two of the original four have since landed: the licence economy is real as
of 27–28-08-26, and the **asset inventory** is real as of 30-08-26 — `design.md` §4's asset-occupancy
ruling. The mockup's asset picker is still a mock, but it now has engine truth to read.)*

---

## 1. What the panel is

Entry: planet manifest → **Resources** tab → click a vacant **resource node** (miner, Tier 1), or
**Settlements** tab → click a vacant **settlement slot** (factory, Tier 2–4). The popup overlays the
manifest. It is **one reactive page, not a wizard** — everything live; Deploy stays disabled until
the venture is fully specified. The FUE is the titanium-mining, Tier-1 case (a new player's literal
first action); factories are the same page with a tier+recipe picker.

On confirm, one **compound action**: pick an idle asset from inventory → `establishVenture` (bind the
asset to the site) → record the licence terms. The venture produces next tick. After establishment
the formerly-vacant site button opens the (undesigned) manage-venture tab.

Controls, top to bottom: **Asset** (dropdown, filtered by site kind) · **Configuration** (fixed
resource for a node; tier + recipe dropdowns for a slot) · **Licence** (Licensed / Unlicensed) ·
**Fee negotiation** (commitment + equity sliders, live fee readout + hinge graph, reputation meter,
renegotiation-window slider) · **Deploy** → an adviser confirm. Section help and the deploy confirm
are delivered by the **Guild Adviser** in a shared hero reel (art right, text left).

---

## 2. Data-point catalogue

Buckets (as `full-client-datapoints.md`): **STORED** (player-set, in the determinism hash) ·
**DERIVED** (recomputed each tick into the snapshot, never persisted) · **IDENTITY** (stable
seed/state facts) · **CONFIG** (tunable constants, not per-save state) · **PRESENTATION**
(client-only, no state) · **FUTURE** (no engine surface yet — the licence layer).

### 2.1 Site context & header
| Data point | Bucket | Field / source |
|---|---|---|
| Node designation ("Resource Node N") | IDENTITY | index/id in seed `planet.resourceNodes[]` |
| Slot designation ("Settlement Slot N") | IDENTITY | index/id in seed `planet.settlementSlots[]` |
| Resource (node) — "Titanium" | IDENTITY | `node.resourceType` → `RESOURCE_LABEL` (presentation) |
| Planet name — "Kepler-9c" | IDENTITY | `planet.name` (+ future `nameOverride`) |
| Archetype — "Terran" | IDENTITY | `planet.archetype` → `ARCHETYPE_LABEL` (presentation) |
| Site is vacant (gate: only vacant sites open the panel) | DERIVED | no `ventures[].siteId` == this site (`sim/occupancy.js`) |
| Treasury (affordability context) | STORED | `guild.credits` |

### 2.2 Asset picker
| Data point | Bucket | Field / source |
|---|---|---|
| Selectable assets, filtered by site kind (miner⇢node, factory⇢slot) | **STORED** | guild-owned IDLE assets — snapshot `guilds[].assets` where `deployedToVentureId === null` (BUILT 30-08-26) |
| Asset id / kind / condition (maintenance %) | STORED | snapshot `guilds[].assets[]` — `{ id, kind, maintenanceCondition }`; condition is carried but INERT until the maintenance slice |

### 2.3 Configuration
| Data point | Bucket | Field / source |
|---|---|---|
| Site kind (node vs slot) → miner vs factory, and whether the tier/recipe picker shows | IDENTITY | derived from the site the player clicked |
| Recipe list per tier | CONFIG | `sim/recipes.js` (Tier-2 refine exists; Tier 3/4 not built, §4) |
| Recipe in→out | IDENTITY | `recipe.inputs[]` → `recipe.output` |
| Selected recipe (slot) / resource (node) | STORED | `venture.recipeId` / `venture.resourceType` |
| Tier (1 node; 2/3/4 slot) | DERIVED | **from the recipe**, not a second stored flag (§4: "a factory's mode follows from the recipe it is assigned") |
| Output good + label | DERIVED | `recipe.output.good` / `resourceType` → label |

### 2.4 Licence & fee negotiation — **all FUTURE** (licence economy not in engine)
| Data point | Bucket | Field / source |
|---|---|---|
| Licensed vs unlicensed | STORED (NEW) | presence of a licence record (§3); today only `venture.syndicateCommitment` placeholder exists |
| Output commitment `c` (0–100%) | STORED (NEW) | licence term; = Gate-1 Syndicate-fork minimum / `venture.syndicateCommitment` |
| Equity offered `o` (0–49%) | STORED (NEW) | licence term (equity/dividends) |
| Baseline output rate | DERIVED | `venture.productionRate` (rating); today fed-in |
| Committed quantity per cycle | DERIVED | `c × baseline × ticks-per-cycle` |
| Fee % of basic | DERIVED | pure fn of `c, o` and the corner/`k` tunables — a `previewFee` selector, engine-computed (never recomputed in the browser, §5 display rule) |
| Fee credits / cycle | DERIVED | `fee% × per-tier basic fee` |
| Per-tier basic fee; corner values; shaping `k` | CONFIG | tunable table → #56 |
| Market rate (commitment-sale value) | DERIVED | from `galacticSupply` (the Exchange value, §5) |
| Income split (owner `1−o` / investors `o`; unsold `o` → Syndicate ledger) | DERIVED | from `o` |
| Breach fee | DERIVED | = full per-tier basic fee (§5) |

### 2.5 Reputation-from-terms — **FUTURE / proposed** (see §4, checklist #63)
| Data point | Bucket | Field / source |
|---|---|---|
| Reputation-gain rate from the terms | DERIVED | fn of `c, o` (rises as fee falls) — `[FIRST-CUT]` formula, #63 |
| Venture / guild standing it accrues into | STORED | `guild.guildReputation` exists; per-venture reputation is #61 |

### 2.6 Renegotiation window — **FUTURE / proposed** (see §4, checklist #64)
| Data point | Bucket | Field / source |
|---|---|---|
| Window length (days) the player sets | STORED (NEW) | licence term |
| Resolved renegotiation-open tick | STORED/DERIVED | `establishTick + days × ticks-per-day` |
| Ticks-per-day / tick-duration constant | CONFIG | `phase-1-tuning.md` (unresolved) — the per-hour/day display seam |

### 2.7 Deploy — the compound action (not data, the write)
`establishVenture({ siteId, assetId, recipeId|resourceType, productionRate })` — which OCCUPIES the asset
it names (BUILT 30-08-26; `assetId` made **required** 31-08-26), so there is no separate `consumeAsset`
step: one action both seats the venture and deploys the machine —
→ `recordLicenceTerms({ licensed, commitment c, equity o, tier/fee basis, renegotiationOpenTick })`.
The venture produces next tick. **Not atomic today:** establish and `applyForLicence` are two intake
actions (see the client-wiring note of 27-08-26), and an *atomic* `establishAndLicence` remains a noted
follow-up. **The picker must now name the machine** — `assetId` is required, and the engine refuses an id
it does not own, one already deployed (naming the venture holding it), and one of the wrong kind, as it
refuses a site in a system the guild does not hold. *(The picker itself is the next client slice; until it
ships, `client/game.html`'s deploy sends no `assetId` and is refused.)*

### 2.8 Presentation-only (no state)
Facility art (derived from archetype/kind/biome, `console-client-and-art.md §3`) · Guild Adviser
portrait + reel copy · the fee hinge-graph and reputation-meter rendering (the browser renders the
engine's DERIVED numbers and computes no game number beyond display ratios, §5) · manifest dot colours.

---

## 3. New STORED structures this panel forces (for the live-state model)

Most of the panel is DERIVED/CONFIG/PRESENTATION. It introduces **three genuinely new STORED things**,
all part of the deferred licence layer — decide each one's shape when that slice is built:

1. **Asset inventory** — **BUILT 30-08-26** (`design.md` §4's asset-occupancy ruling; `sim/assets.js`,
   `guild.assets`). Guild-owned assets: `{ id, kind:'miner'|'factory', maintenanceCondition }`, nested on
   the guild, with a venture referencing one by its nullable `assetId`. Two corrections to the sketch
   above, from the ruling: establishment **OCCUPIES, it does not consume** — the asset stays in the
   inventory and the venture's reference is the whole of what "deployed" means — and **"unbound" is
   DERIVED, never stored**: an asset is idle iff no venture names it, so there is no `isIdle` field
   (invariant 5). Condition is carried but inert; maintenance is its own later slice.
2. **Licence record** (per venture) — `{ licensed, commitment c, equity o, tier/fee basis,
   renegotiationOpenTick, reputationAccrual? }`. `venture.syndicateCommitment` is today's fed-in
   placeholder seed of this.
3. **Per-venture reputation** — if reputation-from-terms is adopted, venture-scoped standing extends
   `guild.guildReputation` (folds into #61, which already makes reputation load-bearing for five
   mechanics).

Everything else the panel shows — fee %, fee credits, committed quantity, income split, breach fee,
market rate, reputation-gain rate, tier — is **DERIVED or CONFIG**, not new stored state.

---

## 4. Rulings captured this session (also in `design.md §5`)

- **Renegotiation window — gates both sides equally.** The player sets a window (in days). It does
  **not** end the contract — the venture runs on the same terms until the window elapses AND someone
  reopens it. Until it elapses, **neither the player nor the Syndicate** may reopen the terms. Once it
  passes, the **player** may renegotiate from venture management, and the **Syndicate** may itself
  initiate if the venture's standing has shifted (offering better or worse terms). Interacts with #57
  (75% investor majority to alter terms) and #61 (what moves reputation).
- **Reputation-from-terms.** Committing output and offering equity build Syndicate standing (standing
  rises as the fee falls); standing later feeds renegotiation (discounts / surcharges) and the
  existing reputation-load-bearing mechanics (§5). *Failure-mode noted:* the deep-entanglement corner
  already pays ~0 fee, so a reputation *discount* mostly benefits mid-fee ventures — an intentional
  shape to confirm, not a bug. Formula is `[FIRST-CUT]` → #63.
- **Commitment floor is 0%** `[FIRST-CUT]` (reconciled — some passages still said 5%). A licensed
  venture may commit nothing and simply pay the full basic fee for the licence's other benefits.

Open numbers: fee corners / `k` / per-tier basic fees → **#56**; reputation-from-terms formula and how
standing maps to renegotiation discounts/surcharges → **#63**; renegotiation-window bounds and the
tick mapping (needs the tick-duration constant) → **#64**.
