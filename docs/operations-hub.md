# Operations — the operations & dispatch hub (design-ahead)

*Design-ahead, like `transport-model.md`: it states the settled shape and flags the open questions;
most of it is built by later slices. The repo wins over this doc. The visual + interaction contract is
the approved OPERATIONS mockup handed to the build; the tab is a peer of the Guild Hall and Deuterium
dashboards and speaks their language (`docs/mockups/guild-hall.html`).*

## 1. What it is

The **OPERATIONS** tab — renamed from *Transport* (the name undersold it) — is the hub for every asset a
guild has **that is uncommitted or in motion — the point from which you send assets out-of-system, or commit them:** a delivery in flight, a structure deployed on the map, an idle
asset in the yard waiting to be sent out, or a transport leased away to the Syndicate. It is where the
player checks their status, opens each asset's management, and — later — dispatches missions.

It is the **list-and-management companion to the galaxy-map transport overlay** (`transport-model.md`
§3/§6): the map shows *where* an in-flight delivery is; this shows the *list*, the detail, and the
*actions*. One reads the other's data.

## 2. The panel (matches `guild-hall.html`; mock: the approved operations-tab mockup)

A full-viewport, three-column panel in the Guild-Hall language (a top-level `openTab` peer of the Guild
Hall and Deuterium dashboards, `#tp-ops`):

- **LEFT hero — LEASED.** Transports on Syndicate contract (away, still in your fleet). Each row is an
  **ID + Type button → the transport-management popup** (stats · recall).
- **CENTRE.** **IN TRANSIT** on top (§4), then **DEPLOYED** and **IDLE** side by side (§5).
- **RIGHT hero — the pilot.** `client/assets/characters/pilot.jpg` under the scrim; "Operations /
  Chief Pilot".

**Every panel is fixed-height with internal scroll** — expanding a row or a type-group scrolls *within*
the panel and never resizes it. This is load-bearing: without it the panels jump as things expand.

## 3. The asset lifecycle (the model the hub renders)

    idle (in the yard) ──Manage──▶ DEPLOY  (any type → placed on a hex)
                          │
                          └──────▶ LEASE to the Syndicate  (transports only)

    deployed  ──▶ DEPLOYED section ──Manage──▶ stats / (un)deploy
    leased    ──▶ LEASED panel     ──tap──────▶ stats / recall
    in flight ──▶ IN TRANSIT

**Transports** are the only craft that fly, lease, and (later) run missions. **Outposts, toll gates,
deep-scan arrays** deploy to a hex and stay — they do **not** lease. A guild's in-system ground assets (mining/refining machines) appear here **only while idle**: an idle machine is a dispatch candidate — deploy it here, or (from 2.2) ship it to another system — which is exactly what this hub is for. The instant it works a venture it is **deployed** and drops out of the hub, belonging to the venture/asset system until it is torn down and idle again. *(**REVERSED 12-09-26**: this once read that in-system ground assets are never shown here; the §1 reframe — from "out-of-system operations" to "the point from which you send things out-of-system, or commit them" — is what flips it: an idle ground asset belongs, a working one does not.)*

## 4. IN TRANSIT — the section built now

Live from the snapshot's `shipments[]` (`transport-model.md` §3), **the player's own only**, **sorted
soonest-arrival first** (ascending `ticksRemaining`). Row, collapsed:

    origin waystation · progress bar · [alert] · time remaining · destination system

- **origin / destination** — the waystation and system *names*, resolved client-side from the seed (the
  snapshot surfaces `originOutpostId`/`originCoords` and `destinationSystemId`).
- **progress bar** — `legProgress` (§2.3), the same derive the map tweens; presentation only.
- **time remaining** — `fmtETA(ticksRemaining)`; `ticksRemaining` is the engine's number, formatted,
  **never recomputed** from `legProgress`.
- **alert** — a **reserved, unwired slot** today. The one real trigger available is *destination lost
  in flight → cargo vanishes* (`design.md` §6), which stays dormant until territory is contestable
  (2.2); pirate damage / maintenance warnings are Phase 4/6.

Expanded, the row shows a **manifest**:

- an **identity line** — for a Syndicate delivery this is the **carrier** (`Syndicate`, a constant;
  there is *no craft id* this tier — `transport-model.md` §3). When a **guild craft** flies the trip
  (Phase 4) this line becomes the **Craft ID as a button → the craft-stats popup** (maintenance, etc.).
- a **MANIFEST** — the cargo, itemised `Good: Nu`. A Syndicate BUY carries a **single good**, so it is
  one line today; the list takes several rows for mixed-cargo **guild** transports (Phase 4).

No fuel is shown here — a Syndicate delivery's fuel is spent once at dispatch, and the fuel gauges live
elsewhere.

## 5. DEPLOYED & IDLE — future (2.1 / 2.2 / 2.3)

Both are **grouped by asset type under collapsible headers** (open Outposts without opening Toll Gates),
each entry an **ID + descriptor button → the Manage popup**.

- **DEPLOYED** — outposts, toll gates, deep-scan arrays (built at 2.1, placed on territory 2.2/2.3).
  **Each entry's descriptor is the asset's HEX COORDINATE — its position on the map. [RULED 10-09-26.]**
  Expanding an outpost shows its stored manifest.
- **IDLE · deployable** — every asset the guild holds **uncommitted**: idle **mining/refining machines** (miners, factories — live from founding), idle transports, and (later) unbuilt kits. **Membership is one rule:** an asset with `deployedToVentureId == null` (`sim/snapshot.js`), guild-wide, **grouped by the system it sits in** (`Asset.systemId`, design.md §4). Idle assets arrive three ways — the **founding grant** (the starter miners/factories, idle from turn one), a **self-build** at the yard (2.1b), or a **Syndicate commission** for credits (2.1d, delivered in) — with the **open market** later (2.1e). Manage → **deploy** (any type, onto a site in that system) or **lease to the Syndicate** (transports only); relocation to another system arrives with 2.2. A machine leaves this list the instant it starts a venture.

DEPLOYED's entities (map structures) don't exist yet, so it stays an **empty scaffold**; **IDLE goes live with the ground-asset inventory (2.1b client)** — founding-granted miners/factories exist from turn one — and gains idle transports and kits as those slices land.

## 6. LEASED — future (Phase 4)

Transports leased to the Syndicate under the lease/recall contract (`transport-model.md` §10 open q —
recall any time, time to re-availability). ID + Type buttons → the transport-management popup
(stats · **recall**). Empty until leasing exists.

## 7. What is built when

- **Now — Phase 2 (this slice, the transport-visibility list companion):** the OPERATIONS frame + the
  rename + **IN TRANSIT live**; DEPLOYED / IDLE / LEASED as empty scaffolds; alert slot reserved.

  **AS-BUILT 10-09-26 (CLIENT half, Phase 2).** Built in `client/game.html` — CLIENT only, no
  engine/snapshot/sim change (determinism goldens byte-identical; the sim test count rose only by the
  one new served-page tripwire in `sim/tests/server.test.js`). The old **Transport** tab (button +
  its `TAB_STUBS` coming-soon entry) is **renamed to OPERATIONS**, now a top-level rendered panel
  (`#tp-ops`) and a peer of TRADE / the Guild Hall / Deuterium — the same `openTab` + overlay pattern
  as the Deuterium dashboard: `openTab('operations')` hides the other overlays, shows `#tp-ops` and
  calls `window.__opsOpen()`; `window.__opsRefresh()` runs from `applySnapshot` beside the other
  panels' refreshers, so an open panel re-reads each poll. The panel is the three-column Guild-Hall
  layout (§2): **LEFT hero — LEASED**, **CENTRE** (IN TRANSIT on top, DEPLOYED + IDLE below), **RIGHT
  hero — the pilot** (`client/assets/characters/pilot.jpg`, "Operations / Chief Pilot"). Every panel is
  fixed-height with internal scroll (the flex `min-height:0` chain + `overflow-y:auto` on the list
  bodies), so expanding a row never resizes a panel.

  **IN TRANSIT is live** (§4): from `window.__snapshot().shipments`, the player's own
  (`ownerGuildId === myGuildId`), dropping any row missing its leg fields, sorted ascending by
  `ticksRemaining` (soonest first). Each row is `origin waystation · progress bar · [reserved alert] ·
  time remaining · destination system` — names resolved off the seed the client holds (`__systemName`
  and a new sibling shell bridge `__outpostName`, the same way the map resolves them); the progress
  bar is `legProgress` (transport-model.md §2.3) off the engine's two ticks; the time is
  `fmtETA(ticksRemaining)`, the engine's own number, **never** recomputed from `legProgress`. Clicking
  a row expands a manifest: the identity line `Carrier: Syndicate` (no craft id this tier, §3) and the
  cargo itemised `Good: Nu` (a Syndicate BUY is single-good → one line; the list takes more). The
  **alert slot is built but unwired** (§4 — its one real trigger stays dormant until territory is
  contestable). **LEASED / DEPLOYED / IDLE are empty scaffolds** (§7): section headers + calm empty
  states ("No transports leased" / "Nothing deployed yet" / "Nothing idle"), no rows and no Manage
  popups — their entities don't exist yet.

  Proven end-to-end in headless Chromium against a booted server: two BUYs to systems the player holds
  at different distances list soonest-first with origin, progress, ETA and destination; expanding the
  top one shows its manifest; the DEPLOYED / IDLE / LEASED sections show their empty states; and a
  rival-owned shipment does not appear. **Deferred, not invented:** the §9 LEASED-panel-when-empty
  question (plain empty state vs interim summary) — built as the plain empty state, the interim-summary
  option deferred to the leasing slice (Phase 4).

  **AS-BUILT 12-09-26 (2.1b CLIENT — IDLE goes live).** **IDLE is now live** off the snapshot (§5),
  CLIENT only — no engine/snapshot/sim change (determinism goldens byte-identical; the sim test count
  is unchanged — the one served-page tripwire in `sim/tests/server.test.js` was updated in place to
  pin the live IDLE contract instead of the old scaffold). The IDLE `ops-card` gained its own list id
  (`#ops-idle-list`) and is filled by the same operations-tab-wire that fills IN TRANSIT — on hub open
  and every poll while open (`__opsRefresh` → `render()`), so it stays live as machines deploy (leave)
  and ventures tear down (return). Membership is the engine's one rule read verbatim
  (`deployedToVentureId == null`, guild-wide, off the guild's `assets` block — the same rows the shell
  caches as `LIVE.myAssets`); the browser computes no game number (§18). Rows are **grouped by system**
  (`Asset.systemId`, resolved to the system name via the shell's `__systemName` bridge) then **by kind**
  under collapsible headers (Miners / Factories), each header carrying a count; each machine row is its
  **ID + kind descriptor** — read-only, no Manage popup (that is §8). A signature guard (the idle set +
  where each sits) rebuilds the tree only when it changes, so a poll never discards the reader's
  collapse state; the all-deployed case keeps a calm empty state. On a fresh founding this renders the
  starter **15 miners + 10 factories, all idle, at the home system** — the payoff. Proven end-to-end in
  headless Chromium against a booted server: a fresh founding shows one system group with 15-miner /
  10-factory subgroups; deploying one miner (`establishVenture`) drops it out of IDLE on the next poll
  (24 idle / 14 miners); tearing the venture down returns it (25 idle / 15 miners). **Deferred, not
  invented:** the Manage popup / deploy-from-hub (§8, future), the same-system deploy-picker filter
  (2.2, design.md §4), and idle transports / build kits (their slices).
- **2.1 (build yard):** idle assets + the **Manage popup** + deploy; DEPLOYED / IDLE populate.
- **2.3 (tolls):** toll gates active; toll-route management.
- **Phase 4 (guild transport + leasing):** guild craft fly trips (Craft IDs + craft-stats in IN
  TRANSIT), leasing + recall (LEASED populates), mission dispatch.

## 8. The management popups (future)

Per-asset **Manage** / **craft-stats** popups follow `docs/popup-standard.md` (the adviser-reel card).
Their per-type actions (transport: stats/deploy/lease/recall; structures: stats/(un)deploy; toll route:
its own stat-and-manage page) are ruled with the slices that build them — not here.

## 9. Open questions

- **LEASED-panel-when-empty** — a plain empty state, or an interim summary (deliveries in flight, units
  in transit, next arrival) until leasing exists?
- **Alert triggers + surfacing** — inline on the row vs the event-log Notices; which conditions light it.
- **Mission dispatch model** — send a transport to an outpost, load goods, move them to a system;
  pre-deployment. Phase 4; shape unruled.
- **Recall-time model** for leased transports (`transport-model.md` §10) — the re-availability delay.
