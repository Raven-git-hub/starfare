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

**AS-BUILT 24-09-26 (guild craft + lanes now render here, 2.2 b2a → 3c; CLIENT `client/game.html`).** IN TRANSIT is no longer Syndicate-only. Alongside the Syndicate `shipments[]` rows above, the panel now lists the guild's OWN in-flight craft and its active REPEATING lanes. A guild row's identity line is the craft's **class + number** (e.g. `mediumTransport #01`) — the *Craft ID → craft-stats popup* named above stays future. A repeating lane adds a read-out — `Lap k of N · X fuel / lap · per-cycle` (every figure the snapshot's; `perLapUnits` is the engine's per-lap cost, the `+1` on `lapsDone` is presentation); a held lane reads `Holding for fuel` or `Next lap at cycle`; and the expanded region carries **Cancel** (asks first, then `cancelRoute`) and **Stop after this run** (`stopRouteAfterRun`, repeating lanes only). A lane that ENDS on its own — a stop's store gone, `laneEnded { reason: 'target-gone' }` — raises a dismissible notice at the top of IN TRANSIT (the alert's "destination lost in flight" trigger, now real for guild lanes; the reserved per-row alert pill is still unwired). *(⤳ 28-10-26, losing ground client slice 2: a second reason reads in words — `laneEnded { reason: 'system-lost' }`, a stop's system lost and gone fallow, as "Light #05's lane stopped at Nyx — a stop's system was lost." (draft copy). It names no system: the flag carries none, and the craft lands at the end of whatever leg it was flying, which need not be the lost system. Such a lane can end while its craft is still FLYING (`transport-model.md` §11.6), with no `location` yet, so the notice now names where it will land — the leg's end, the destination its IN TRANSIT row already shows (`craftDestName`) — where it read "stopped at Unknown"; a landed craft reads its `location` as before. The strip's rebuild signature now carries that place too, so a craft that lands on a bare hex redraws its notice once ("Deep Space (q, r)" → "(q, r)"). `target-gone` reads exactly as before.)* *(⤳ 29-10-26, losing ground client slice 4 — the salvage run: a heavy carrying a MACHINE (the snapshot's `carryingAssetId`; `territory-model.md` §5) carries no cargo, so its manifest read "No cargo.". It now names the machine — its kind, read from the machine's own asset row, in a Syndicate machine delivery's words ("Miner Asset"), with its id beside it — over a Hold line that reads the engine's own `used / capacity`, full, marked **"· locked"** (draft copy), because nothing else can go in beside it. The row's signature carries the machine too: no player act changes a hold in flight, but the operator's `removeAsset` of the carried machine does, and the open manifest then redraws to "No cargo.". A laden heavy flies on an ordinary dispatch, so it reaches this list the way any craft does; nothing about the flight was built.)* **Still future:** the Craft-ID craft-stats popup, and the full DEPLOYED / IDLE / LEASED board where a waiting or ended-lane craft would also live (Phase 4).

## 5. DEPLOYED & IDLE — future (2.1 / 2.2 / 2.3)

Both are **grouped by asset type under collapsible headers** (open Outposts without opening Toll Gates),
each entry an **ID + descriptor button → the Manage popup**.

- **DEPLOYED** — outposts, toll gates, deep-scan arrays (built at 2.1, placed on territory 2.2/2.3).
  **Each entry's descriptor is the asset's HEX COORDINATE — its position on the map. [RULED 10-09-26.]**
  Expanding an outpost shows its stored manifest.
- **IDLE · deployable** — every asset the guild holds **uncommitted**: idle **mining/refining machines** (miners, factories — live from founding), idle transports, and (later) unbuilt kits. **Membership is one rule:** an asset with `deployedToVentureId == null` (`sim/snapshot.js`), guild-wide, **grouped by the system it sits in** (`Asset.systemId`, design.md §4). Idle assets arrive three ways — the **founding grant** (the starter miners/factories, idle from turn one), a **self-build** at the yard (2.1b), or a **Syndicate commission** for credits (2.1d, delivered in) — with the **open market** later (2.1e). Manage → **deploy** (any type, onto a site in that system) or **lease to the Syndicate** (transports only); relocation to another system arrives with 2.2. A machine leaves this list the instant it starts a venture.

DEPLOYED's entities (map structures) don't exist yet, so it stays an **empty scaffold**; **IDLE goes live with the ground-asset inventory (2.1b client)** — founding-granted miners/factories exist from turn one — and gains idle transports and kits as those slices land.

**AS-BUILT 15-10-26 — DEPLOYED goes live, read-only (roadmap 2.5 slice 14b; `client/game.html`).** The card lists the
guild's own **Outposts** and **Deep Scan Arrays** off their snapshot rows (`outposts`, `deepScanArrays` — the per-guild
view carries the guild's own), **grouped by type under collapsible headers** in the IDLE tree's own idiom (its classes
and caret; the collapse survives a poll). Each entry is its name — an Outpost's "<anchor system> Outpost", an array's
"Deep Scan Array NN" — with its **hex coordinate as the descriptor** (the 10-09-26 ruling above), over one state line:
"anchored to <system>"; an array adds what its row says, "idle" or "surveying <target> · <time left>" (the job's own
`completeTick`). An honest empty state ("Nothing deployed yet") replaces the old "from the build yard, 2.1" scaffold copy.
**Not built:** the Manage popup and an Outpost's stored-manifest expansion (the Outpost Manager, opened from the map,
remains where an Outpost is inspected); toll gates (no entity yet). IDLE now also labels kits by kind ("Deep Scan Array
kit", grouped "Deep Scan Array kits") and gives every kit kind a Deploy button.

**AS-BUILT 28-10-26 — a STRANDED machine is marked (losing ground client slice 2; `client/game.html` only).** A
machine or kit an eviction left behind carries the engine's `stranded = { tick }` (`territory-model.md` §4), and IDLE now
reads it: the row gains an amber state line under its id, kind and any button, **"Stranded · awaiting salvage"** (draft
copy) — the second line a DEPLOYED row carries — and takes the ended-lane notice's amber edge and wash. The row wraps
for it, so the line takes no width from the id: the IDLE card is narrow (it shares the middle column with DEPLOYED).
A mark on the row, not a group of its own: the row stays in its system's group, which is the system it was lost in.
The flag is the engine's answer and the only thing read; the row never asks whether the guild still holds the system
(design.md §18). A stranded kit keeps its Deploy / Ferry
button, because it loads like any kit. An ordinary row is byte-identical to before. **The signature now carries the
flag.** The tree rebuilt on `id@systemId`, but an eviction flags a machine IN PLACE (same id, same system), and a
salvage load clears the flag in place, so the marker would never have appeared, or never gone. `idleSignature` adds a
stranded term; an unchanged poll still rebuilds nothing. Unchanged: the system header's "N idle" and the kind counts
include stranded rows; no day is shown (the client may not turn a tick into a day — the asset row carries no
`whenDay`). Not built: a machine aboard a heavy (the salvage load) still lists here under the fallow system, because
`myIdle` reads only `deployedToVentureId` and not the snapshot's `inTransitOnVehicleId` — the salvage-run client's
(roadmap checklist). Proved by `sim/tests/losing-ground-ops-client.test.js`. *(⤳ 29-10-26: BUILT — losing ground client
slice 4, below. A loaded machine now leaves IDLE, so the salvage load is no longer an in-place clear of the flag; the
owner's re-plant, which recovers its stranded machines in place, still is, and the signature's stranded term is for
that and for the eviction.)*

**AS-BUILT 29-10-26 — the salvage run, from the client (losing ground client slice 4; `client/game.html` only).** The
engine's salvage run (`territory-model.md` §5 — `loadAsset` in the fallow system, an ordinary dispatch, `unloadAsset` at a
held system) could be played only from the operator CLI. The player now has the three steps, and sees the machine
throughout. No engine, snapshot or fog change (`carryingAssetId`, `inTransitOnVehicleId` and `stranded` were already
published); no new number. The words are drafts.
- **Salvage, on a stranded machine's IDLE row.** A stranded miner or factory gets a **Salvage** button where a kit has
  its Deploy (a stranded kit keeps its own Deploy / Ferry). It is live only when the load could pass: an empty, idle
  heavy, off any lane, with no machine aboard, berthed in the machine's own system — the deploy popup's carrier list,
  `carriersFor`, which the row asks through `window.__carriersFor`. Those are `loadAsset`'s carrier gates, and
  `loadKit`'s too, so the kit's Carrier dropdown and Salvage read one list. With no such heavy the button is drawn
  disabled, its title saying why ("No empty, idle heavy transport is berthed in this system"). Live, it opens the
  **deploy popup in a salvage mode** (`openSalvage`): "Salvage Miner", the machine and where it lies, the heavy
  transport's portrait, the same Carrier dropdown, and one commit, **Salvage**, which sends `loadAsset { guildId,
  vehicleId, assetId }`. There is no route to plan: the load is the whole act. An accepted load closes the popup and
  re-reads the snapshot; a refusal shows the engine's reason and keeps it open. The carrier is re-read off the live
  snapshot at the click, as Plan Route re-reads it, so one that has left is never sent.
- **A carried machine is not idle.** `myIdle` now also leaves out a row carrying `inTransitOnVehicleId` — the engine's own
  `idleAssets` rule — so a machine leaves IDLE when it is loaded and returns, in the held system's group, as an ordinary
  row when it is unloaded. Membership moving moves the signature by itself. What did not move it is a heavy arriving in,
  or leaving, a fallow system: the stranded rows keep their id, system and flag, while their Salvage turns live or dead.
  So `idleSignature` adds whether a row's Salvage is live.
- **The laden heavy.** Its IDLE TRANSPORTS card read "Hold empty" under a full Hold. Its hold now names the machine (as
  the IN TRANSIT manifest does, §4) and the Hold reads "· locked". **Dock** steps aside on it: a laden hold is locked, and
  the engine refuses it every transfer. **Unload** appears in Dock's place when `unloadAsset` would pass — a machine
  aboard, idle, off any lane, berthed AT a system (not a bare hex, not an Outpost) the guild holds, "holds" read off the
  snapshot's own claim rows as the engine's `guildHolds` reads its claims. So a heavy just loaded in the fallow system
  shows none until it has flown somewhere held. Unload sends `unloadAsset { guildId, vehicleId }` (the engine reads the
  machine off the craft and the system off its berth). It is held disabled while it posts. A refusal stays on the card
  until the tick moves on, as a lane control's does (§4). The card's signature now carries the machine aboard, whether
  Unload is offered, and which cards hold an Unload in flight or its refusal. A load or unload changes neither the cargo
  nor anything else the signature read, so without these terms the card would have frozen.
- **The flight between is an ordinary dispatch.** The Dispatch popup builds a plain `dispatchVehicle` for a route with no
  stop actions, the engine's quote allows it for a laden heavy, and the heavy lists under IN TRANSIT with its manifest.
- Proved by `sim/tests/salvage-client.test.js`, over the galaxy in `sim/tests/salvage-script.js`.

**AS-BUILT 29-10-26 — a DARK array reads dark (losing ground client slice 3; engine + client).** The snapshot's array
row now carries the engine's `dark: true` while the array is not attached to the guild's control
(`exploration-model.md` §5). DEPLOYED reads that flag, and checks it before the idle / surveying split: a dark array's
state line reads **"dark · touches no territory you hold"** (draft copy), in the stranded marker's amber, where it read
"idle · anchored to <system>". The anchor is no longer named, because it no longer holds the array up. A dark array
never carries a job, so it is never "busy". The flag is the only thing read; the row never asks what the guild holds
(design.md §18). Every other row is byte-identical, and the list needs no signature: it diffs its own html, so an
array going dark while idle redraws it on the next poll. Unchanged: the kind header's count includes dark arrays.
Proved by `sim/tests/losing-ground-dark-client.test.js`.

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
  **ID + kind descriptor** — read-only, no Manage popup (that is §8). *(⤳ 02-10-26: an idle OUTPOST row — an undeployed kit — carries a **Deploy** button, which opens the Deploy Outpost popup; roadmap 2.2 deploy pipeline, `territory-model.md` §5 "AS-BUILT — asset-initiated client slice 2a".)* A signature guard (the idle set +
  where each sits) rebuilds the tree only when it changes, so a poll never discards the reader's
  collapse state; the all-deployed case keeps a calm empty state. On a fresh founding this renders the
  starter **15 miners + 10 factories, all idle, at the home system** — the payoff. Proven end-to-end in
  headless Chromium against a booted server: a fresh founding shows one system group with 15-miner /
  10-factory subgroups; deploying one miner (`establishVenture`) drops it out of IDLE on the next poll
  (24 idle / 14 miners); tearing the venture down returns it (25 idle / 15 miners). **Deferred, not
  invented:** the Manage popup / deploy-from-hub (§8, future), the same-system deploy-picker filter
  (2.2, design.md §4) *(⤳ 29-10-26: BUILT — `roadmap.md` 2.5, "The Establish picker's scope fix")*, and idle
  transports / build kits (their slices).
- **2.1 (build yard):** idle assets + the **Manage popup** + deploy; DEPLOYED / IDLE populate.
- **2.3 (tolls):** toll gates active; toll-route management.
- **2.2 b2a → 3c (guild craft + lanes in IN TRANSIT) — BUILT (19–24-09-26):** the guild's own in-flight
  craft render in IN TRANSIT, and its repeating lanes show the lap read-out (`Lap k of N · fuel / lap ·
  per-cycle`), the held states (`Holding for fuel` / `Next lap at cycle`), Cancel / Stop-after-run, and an
  ended-lane notice (§4 AS-BUILT). CLIENT only.
- **Phase 4 (leasing + craft-stats):** the Craft ID → craft-stats popup on an IN TRANSIT row, leasing +
  recall (LEASED populates), mission dispatch.

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
