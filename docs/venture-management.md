# Venture Management — the popup + two snapshot derives (built 08-09-26)

*Status: **BUILT 08-09-26.** This is the first concrete build of the "venture management" hole
(design.md §2.7, undesigned until now) and the home of the **Close-venture** action shipped last slice
(`docs/venture-teardown.md`). It is **almost entirely client** — a superimposed popup, the mirror of the
Venture Establishment popup (`docs/venture-establishment.md`) — plus **two pure snapshot derives** the
panel reads. It **invents no number**: every figure is a published/ruled term.*

## 0. The one-line frame

`openVentureManagement(ventureId)` was a stub that only logged (design.md §2.7). It is now the real
**Venture Management popup**: a guild opens it on a venture it owns to see that venture's live
**reputation, production, investors and agreed terms**, and to **Close** the venture (through the Guild
Adviser confirm reel, firing the built `decommissionVenture`). **Five call sites** open it — all the
one `window.__openVentureManagement(ventureId)` entry point, no second popup:

1. the post-establish "Open venture management ▸";
2. the industrial-hero "Open venture management ▸" (the SYSTEM MANIFEST's Production Console selects a
   venture chip → the parent `#indHero` → its `#ihManage` button);
3. the DEUTERIUM tab's refinery-row click;
4. **(this slice)** an **own occupied Planet-Manifest node** (Resources or Settlements) — the row that
   used to open the read-only overlay now opens VM when the seated venture is the player's own;
5. **(this slice)** the Production Console venture-hero's manage button — which, in the embedded
   manifest view, IS the same parent `#ihManage` as (2): embed mode drops the console's own `.vhero`
   zone, so the chip selection rides the venture `postMessage` bridge up to the shell's hero. It was
   already wired; this slice verified it end-to-end (no new code, no cross-frame bridge needed).

A **rival's** occupied node stays the read-only overlay — §7 hides a rival's venture and VM is built
from your OWN ventures, so it is own-only. A **vacant** node is unchanged (establishment).

## 1. The two snapshot derives (engine; `sim/snapshot.js`, pure)

Both are **per-venture, DERIVED on read** — no stored byte, no determinism hash, so **no state golden
moves**. Additive, **no schema bump** (schema stays 7).

### `contractWindow` — the licence's window in CYCLES

A cycle is a day is `windowN` ticks (`sim/windows.js`). For an ordinary-licensed venture (`v.licence`):

    windowN         = state.windowN ?? DEFAULT_WINDOW_N
    endTick         = licence.signedTick + licence.windowDays × windowN
    cyclesRemaining = max(0, licence.windowDays − floor((state.tick − licence.signedTick) / windowN))
    contractWindow  = { endTick, endCycle: floor(endTick / windowN), cyclesRemaining, expired: cyclesRemaining === 0 }

`null` for an unlicensed venture and for a windowless deuterium-licensed mine. **`endTick` is the same
value `teardownSettlement.lockoutUntilTick` uses when not expired** — both go through the factored
`licenceEndTick(licence, windowN)` (`sim/licence.js`), so the panel's window and the charged settlement
cannot disagree about the term's end. `cyclesRemaining` is the same remaining-cycles the §3.2 settlement
fee is priced on.

### `equityPerCycle` — the investor (equity) payout projection

An integer credits value (§15.2), the `o`-share of the commitment sale at the current price:

    equityPerCycle = round(committedOutputPct × productionRate × windowN × equityPct × postedPrice(good))

where `good` is `producedGoodFor(venture)`. `0` when unlicensed, no equity offered, or deuterium (no
posted price). It is a **projection** (rate × cycle, deliberately raw-unlimited, like `deuteriumProduction`)
— the engine deciding the number so the client renders it (§5), not the browser multiplying five fields.
There is no investor market yet, so nothing is actually paid out; the `o` share still routes to the
Syndicate ledger.

## 2. The popup (client; `client/game.html`), modelled on the Establishment popup

`#vm-overlay` mirrors `#est-overlay` — the 980px two-column card, own scoped palette, reusing the est
card/hero/ledger language. It re-renders on every `applySnapshot` poll while open (`window.__vmRefresh`),
the Guild Hall / DEUTERIUM lifecycle.

- **Header** — `Venture Management` eyebrow · venture name · `site.name · system` · close ✕.
- **Left (data):**
  - **Reputation** — the big signed `venture.reputation` coloured by zone, label GRADE, over a band gauge
    across `[−500, 1500]` with a needle at the RP and marks at −500 (CLOSURE), −300, 800, +1000 (DIVIDEND).
    `RP_FLOOR` / `RP_SOFT_CAP` are **mirrored** from `sim/licence.js` with a served-page tripwire. The
    closure/forced-lease/dividend effects are designed, not built — the marks are structure.
  - **Production (donut)** — licensed & committed: `delivered / committed` this cycle from the published
    window view, red when the pace is behind. Unlicensed/deuterium/no-commitment: a full ring, centre =
    `productionRate × windowN`, sub-line "kept · off books" / "auto-sold to fuel".
  - **Investors** — `equityPerCycle` labelled "Equity / cycle · cr"; the list is an empty placeholder
    ("No investor guilds yet — the `o`% share goes to the Syndicate ledger" / "No equity offered.").
- **Right (hero):** biome×type art (§3) + scrim; the **agreed-terms ledger** (Committed %, Equity %,
  Fee / cycle = `discountedFee` of `basicFee`, Locked price); the **contract window** in cycles
  ("Window · ends cycle N · {cyclesRemaining} of {windowDays} cycles left", or "Term elapsed · rolling ·
  open to renegotiation" when expired); and the **actions** — Close venture (Adviser reel, §4), plus a
  Renegotiate ▸ **stub** (#64, coming soon) when expired. For a **licensed deuterium mine** Close is
  disabled ("The Syndicate does not let go of deuterium — teardown deferred (§6)").

The client computes **no game number** (§5) — it renders the published fields (RP, the settlement, the
two derives) and only sanctioned presentation (a needle position, an arc length, a bar width, a cycle
label).

## 3. The hero art — biome × type (client-only)

The biome (planet archetype) is resolved from the venture's `site` via the client's **existing** embedded
seed (`window.__galaxy`), the same the manifest/establish flow uses — **archetype is never added to the
snapshot.** The type is `mine` for a mining venture, `factory` for a refining venture / illegal deuterium
refinery. The art is an **EXPLICIT table** (files in `client/assets/industrial/`) — the filenames are
irregular, so they are **not derived**:

**Mines:** rocky→`RockyMine.jpg`, oceanic→`OceanicMine.jpg`, ice→`icemine.jpg`, desert→`desertmine.jpg`,
crystalline→`crystallinemine.jpg`, molten→`moltenmine.jpg`, irradiated→`irradiatedmine.jpg`,
terran→`TerranMountain.jpg` (Terran has other art — Coast/Continental/Forrest/Rig/Riverbed — but
**Mountain for every Terran mine this slice**; the variety is a later ruling), gasGiant→`gasfactory.jpg`
(**this file is a mislabelled gas *mine*** — used for the gas-giant mine).

**Factories** (only terran/rocky/desert/ice/crystalline/oceanic have settlement slots): terran→
`TerranManufacture.jpg`, desert→`desertfactory.jpg`, ice→`icefactory.jpg`, crystalline→`crystalfactory.jpg`,
**rocky→`RockyMine.jpg` and oceanic→`OceanicMine.jpg` (TEMPORARY placeholders — those two factory artworks
do not exist yet, so we fall back to the biome's mine art until they are made).**

A biome/type with no entry (should be unreachable) falls back to `TerranMountain.jpg` rather than a broken
image.

## 4. The Close-venture confirm (Guild Adviser reel)

Close venture opens the existing `#est-reel` card (via a small generic `window.__adviserConfirm` hook so
the reel machinery stays in one place), showing the settlement from the published `teardownSettlement`
(`settlementFee`, `lockoutUntilTick`, `rpForfeit`) and, on confirm, sends
`{ type:'decommissionVenture', guildId, ventureId }` via `window.__sendAction`; on success it closes the
popup and lets the poll refresh the views. Three copies (em-amber numbers): unlicensed/illegal (clean),
licensed in-term, licensed past-term.

## 5. Out of scope (not built, nothing approximates it)

- Renegotiation (#64) — the button is a stub only.
- Licensed deuterium mine teardown — Close disabled (the engine refuses it; teardown §6).
- The investor market — the list is an empty placeholder; `equityPerCycle` is a projection, nothing is
  paid out.
- Terran mine art variety — Mountain for all Terran mines this slice.
- The missing rocky/oceanic **factory** art — the mine-art fallback, flagged above.
- Any `sim/` change beyond the two pure derives — no new action, no stored state, no golden move.

## 6. Proof

- Full sim suite green (`node --test` from `sim/`). New `sim/tests/venture-management.test.js` proves both
  derives (contractWindow cycles decreasing across a boundary and `expired` past term; `equityPerCycle`
  matches the formula and is 0 for a 0-equity / unlicensed / deuterium venture; a purity check that
  building the snapshot moves no state — so **no golden moved**). The served-page tripwire
  (`sim/tests/server.test.js`) pins the popup shell, the mirrored RP band constants, the art table, the
  three call sites, the `decommissionVenture` wire, and that the two derives are published.
- End-to-end in headless Chromium: found → establish + licence → tick → open the popup from a call site →
  the RP gauge, the production donut, the equity/cycle + investor placeholder, the hero terms + biome art +
  contract window; Close → the Adviser reel shows the settlement → confirm fires `decommissionVenture` →
  the venture is gone. The expired state reveals the Renegotiate stub; the unlicensed state closes clean;
  a licensed deuterium mine shows Close disabled.
