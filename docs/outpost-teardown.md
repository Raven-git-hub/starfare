# Outpost teardown / redeploy — reclaiming a deployed Outpost into a kit *(RULED 05-10-26; BUILT 05-10-26 — engine half AS-BUILT §9, client half AS-BUILT §10)*

The reclaim half of the deploy pipeline: turn a deployed guild Outpost back into an Outpost kit
sitting in a heavy transport's hold, ready to be moved and deployed again. It is the inverse of
`deployKit`, and it lands in exactly the state `loadKit` leaves behind, so everything downstream
(dispatch, the on-arrival deploy, the retreat, the Return fork) is reused unchanged. Companion to
`design.md` §4 (the Guild Outpost; the kit as a system-scoped idle asset) and `territory-model.md`
§5 (the deploy flow). Cashes the "outpost mobility" note.

## 1. The goal

Andy's words: *produce an idle heavy transport with an outpost in its hold, ready for the player to
move and begin the deployment flow again.* This slice adds only the reclaim. It builds no new
downstream path.

## 2. The action and its gate

One new journalled action, **`reclaimOutpost { guildId, outpostId }`**, sitting beside
`removeOutpost`. It is valid only when all three rules hold:

1. **Empty and quiet.** The Outpost's stockpile is empty AND nothing is docked (its `queue` and
   `slots` are both empty).
2. **Exactly one craft is parked on the Outpost's hex, and it is an empty heavy.** "Parked" means an
   own craft whose resolved location is the Outpost's hex (the `ownedOutpostAtCraft` coincidence).
   That craft must be a heavy transport, idle, off any lane, with an empty hold, and no other own craft
   may be parked there. The kit is stored into that heavy. Strict one: a second parked craft, a
   non-heavy, or a heavy with a non-empty hold is refused. The engine never picks among several.
3. **Instantaneous.** The reclaim resolves on the tick it is issued.

**Distinct refusals, in this order** (each its own reason, so the client can explain the gate; the
engine is the only judge): the guild is unknown; the Outpost is unknown or not this guild's; the
stockpile is not empty; a craft is docked or queued; no craft is parked on the hex; more than one
craft is parked on the hex; the parked craft is not a heavy transport; the heavy is not idle or is
running a lane; the heavy's hold is not empty.

## 3. The result

- The Outpost row is deleted (its single-hex claim goes with it, leaving a bare hex). The guild's
  `outpostSerial` is untouched, so the removed Outpost id is never reissued (§15.4).
- The heavy ends **laden with one kit, idle, on the now-bare hex, re-dispatchable**: its hold is
  `{ outpost_kit: 1 }`, the same "kit in a heavy's hold" state `loadKit` produces. The kit is NOT put
  into a system inventory. The craft's `updatedAtTick` is stamped (§15.2).
- The player then dispatches and deploys through the existing flow. *(⤳ 05-10-26: true of the engine; the client
  has no button for it yet. See §10, "A finding", and the decision checklist.)*

**Ruling on ids (a gap the seed left open).** In a hold the kit is a *good* (`outpost_kit`) with no
id of its own; only a kit *asset* in an inventory has an id, and `loadKit` already destroys that id
when it moves the kit aboard. So the reclaim mints no asset and does **not** bump `kitAssetSerial`.
"Ids never repeat" still holds: a redeploy creates a new Outpost, which takes a fresh id from
`outpostSerial` (`outpost_<guild>_01` -> `_02`), and if the player later unloads the kit into an
inventory, `kitIntoInventory` mints a fresh kit asset from the serial as it always does. Bumping the
serial here would only leave a numbering gap that nothing reads.

## 4. Why it is built this way

- **The empty heavy is forced, not a preference.** A kit's cargo volume is a whole heavy hold
  (`ASSET_CARGO_VOLUME = HEAVY_HOLD`). Only a heavy holds it, and the hold must be empty because the
  kit takes all of it.
- **Instantaneous is consistent, not an exception.** The dock turnaround (heavy = 120 ticks) is for
  *goods* moving through the queue/slots. Kit load, unload and deploy are a different, already-instant
  family. A reclaim is a structural conversion with an empty stockpile and nothing docking, so it
  belongs to that family. It is not an oversight against the turnaround model.
- **It moves no game number, and it conserves.** Game Points count only held systems and ventures; an
  Outpost does not figure in GP, and neither does an idle kit. So a reclaim is GP-, mean-line- and
  fuel-neutral. The empty-stockpile gate means no goods are destroyed, so Galactic Supply is untouched
  (an Outpost's stockpile is empty, and a kit is not a stockpile good).

## 5. Failure modes considered (on paper, before the build)

- **A second reclaim in the same tick, or a stale client.** The first removes the row; the second is
  refused "no outpost" by the normal ownership gate. Nothing double-mints.
- **Shipments and lanes still bound for this Outpost** (a Syndicate buy in flight, a lane with a stop
  here, a queued route). These are handled by the machinery `removeOutpost` already relies on: the
  arrival finds the target gone and the existing `target-gone` / turn-back paths run. The reclaim adds
  no new handling. A tripwire proves one in-flight buy still lands safely after a reclaim.
- **A parked craft that is mid-lane.** Refused (it must be off any lane); stop the lane first.
- **A heavy carrying stale flags** (`deployFailed`, `laneEnded`). Left exactly as `kitIntoHold` leaves
  them; the next dispatch clears them as it already does.
- **A craft whose `location` names the Outpost rather than a bare hex.** Guild Outposts are not a
  location kind today (`design.md` §4); the build must confirm this and, if any form can name the
  Outpost, rewrite it to the bare hex so nothing dangles.
- **Redeploying out of range.** Handled by the existing `deployCheck` (range from a held system), at
  dispatch and on arrival. Nothing new.

## 6. Out of scope

- **Territory-era interactions** — reclaiming an Outpost whose anchor system has been lost, and a
  rival's craft parked on the Outpost's hex. Both are moot in the single-guild rig and are deferred to
  the territory thread. Only the guild's own craft are counted as "parked".
- **Building Outpost kits** (a dockyard path) — a later rung.
- **`removeOutpost`'s destroy semantics** — unchanged. The reclaim is a separate action beside it.
- Any action button on the success notice (§8). It is a call to action only; Show on map is its one control.

## 7. Build shape

Two slices, engine then client: (1) the `reclaimOutpost` action, its gate, the kit-into-hold, the
distinct refusals, the `outpost_packed` notice write (§8) and tripwires; (2) a small gated Teardown
affordance in the Outpost Manager, and the notice's inbox row and pilot popup. No new
number, so nothing goes to `phase-1-tuning.md`.

## 8. The success notice — `outpost_packed` (RULED 05-10-26)

A successful reclaim writes one notice to the guild's event log, in the standard MESSAGES format and the
pilot's voice (`event-log.md` §12 holds the full spec). It is a call to action: the player now has a
packed Outpost and has to decide where it goes.

- **Writer.** The `reclaimOutpost` apply, through the shared `recordEvent`, on the tick the action lands.
  One writer, so the notice cannot disagree with what happened. Born unread; retention and acknowledge are
  `event-log.md` §3 / §4's, unchanged.
- **Payload** (self-contained, built before the Outpost row goes): `outpostId`, `anchorSystemId`,
  `anchorSystemName` (the seed name, falling back to the id), `hex { q, r }` (where the Outpost stood),
  `craftId`, `craftClass`.
- **Surface.** The pilot is the hero, the eyebrow is "Fleet — Dispatch", and the body is verbatim:
  > The outpost has been packed up, ready to be deployed, Guildmaster. Where do you want me to take it?
- **One control: Show on map.** No Deploy button, no fork. Show on map closes the popup and flies the map to
  the heavy's current hex, found live by `craftId`. If the heavy is no longer idle on a hex (the player has
  already sent it off), it falls back to `payload.hex`, where the Outpost stood.
- **Why a notice at all.** The reclaim's visible result is a vanished Outpost and a heavy in a list; the
  player may not be looking at either. The pilot's question puts the next step, dispatch and deploy through
  the existing flow, in front of them.

## 9. AS-BUILT — the engine half (05-10-26; engine only, NO client)

Built to §1–§8, **no design change and no new number**. The ruling above is kept as written; this section
records what the code does.

**Files and functions touched.**
- `sim/actions.js` —
  - `createReclaimOutpostAction({ guildId, outpostId })` beside `createRemoveOutpostAction`, with the same
    required-argument throws; it returns `{ type: 'reclaimOutpost', guildId, outpostId }` and is exported with
    its neighbours.
  - The `reclaimOutpost` validate branch, directly after `removeOutpost`'s: the §2 gate, refused in the §2 order.
  - The `reclaimOutpost` apply branch, directly after `removeOutpost`'s. It reads the Outpost, the guild and
    the one parked heavy. It builds the §8 payload first, because the payload reads the row. Then it deletes
    the row, dropping `state.outposts` when it empties (as `removeOutpost` does), and stows the kit. It writes
    the notice and refreshes `galacticSupply`. It does **not** reuse `removeOutpost`'s eviction loop or its
    goods sink: the gate has proved there is nothing to evict and nothing to destroy. The code comment says why.
  - **`stowKit(craft, kitGood, tick)`** (new). This is the one line that puts a kit good in a hold, as the whole
    hold, with the craft's tick stamped. `kitIntoHold` (the load) now calls it, and the reclaim calls it too.
    So "the same state `loadKit` leaves" holds by construction, not because two copies of a line were kept in
    step. `kitIntoHold`'s behaviour is byte-identical.
  - **`craftParkedAt(state, outpost)`** (new). It returns the owner's craft whose resolved location is the
    Outpost's hex. It asks the existing `ownedOutpostAtCraft` hex-coincidence question, so "parked here" and
    "at this Outpost" cannot disagree. A craft in flight has no location, so it is never parked. Only the
    owner's craft count; a rival's craft on the hex is the territory-era case §6 defers.
  - `removeOutpost`: **unchanged** (its constructor, validate and apply lines are untouched in the diff).
- `sim/events.js` — `OUTPOST_PACKED = 'outpost_packed'` joins `EVENT_TYPES` and the exports, so
  `checkEventLog` accepts it. `recordEvent`, retention, acknowledge and `cloneEventPayload` are untouched.
- No snapshot, invariant, tick, server, persist or `tools/` change. `POST /action` and journal replay are
  type-agnostic: they take any action through `validateAction` / `applyAction`. No list of action types
  exists anywhere to extend. No admin endpoint or CLI command was added, since none is needed; the client
  slice sends the action through `POST /action`.

**The refusals as built**, in order. Each is its own reason string; the client slice can show them verbatim.
`<…>` marks a value filled in at run time.
1. `no guild with id "<guildId>"`
2. `guild "<guildId>" owns no outpost "<outpostId>"`: the Outpost is unknown, or it is another guild's.
   A second reclaim of an Outpost already packed fails here.
3. `Outpost "<id>" still holds goods (<stockpile JSON>) — empty its stockpile first (sell from it, or load the
   goods out); only an empty Outpost packs into a kit`. Only a positive quantity counts as goods. The engine
   deletes a stockpile key when it reaches 0, so in practice any key is goods.
4. `vehicle "<id>" is mid-transfer in a dock slot at Outpost "<id>" — wait for its turnaround to finish; an
   Outpost packs up only when nothing is docked`. A **queued** craft gets
   `vehicle "<id>" is queued to dock at Outpost "<id>" — let its transfer run, or re-dispatch it to cancel; an
   Outpost packs up only when nothing is docked`. Both are read straight off the Outpost's own `slots` / `queue`.
5. `no craft of guild "<guildId>" is parked on Outpost "<id>" (hex { q: <q>, r: <r> }) — park an empty heavy
   transport on this Outpost first; the Outpost is packed into its hold`
6. `<N> craft are parked on Outpost "<id>" ("<id>", "<id>", …) — exactly one, an empty heavy transport, may be
   parked there to pack it up; move the others off first`. Two heavies are refused too.
7. `vehicle "<id>" parked on Outpost "<id>" is a <class> — a packed Outpost fills a whole heavy hold, so only a
   heavy transport can carry it; park an empty heavy here instead`
8. `vehicle "<id>" is not idle (status "<status>") — an Outpost packs into an idle heavy only`. A heavy on a
   lane gets `vehicle "<id>" is running a lane — a packed kit never rides one; stop the lane or re-dispatch the
   craft first (transport-model.md §11.10)`. In a sound state the not-idle case cannot happen: a loading craft
   is in a slot, so check 4 refuses it first. It stays as the gate's guard against a corrupt state.
9. `vehicle "<id>" has cargo aboard (<cargo JSON>) — unload it first; a packed Outpost needs an EMPTY heavy hold`

**The result as built.** The heavy's hold is exactly `{ outpost_kit: 1 }`. It stays idle on the same bare
hex, and its `updatedAtTick` is the action's tick. Any stale `deployFailed` / `laneEnded` flag is left
exactly as a load leaves it (§5). Nothing else is touched: `guild.outpostSerial` and `kitAssetSerial` keep
their values, and no asset is minted. The notice is one `outpost_packed` row on the guild, born unread, on
the action's tick, with the payload `{ outpostId, anchorSystemId, anchorSystemName, hex: { q, r }, craftId,
craftClass }`. `anchorSystemName` is the seed name, falling back to the id, as `resolveDeployArrival`'s
`retreatSystemName` does. `hex` is a fresh copy.

**The location finding (§5).** A craft's `location` can **never** name a guild Outpost. A landmark ref is
judged by `resolveVehicleLocation`, which accepts `landmarkKind` `'system'` or `'outpost'` and resolves it
through `getLandmark`. There, `'outpost'` means the seed's Syndicate **waystations** (`getOutpost`, ids
`out_NN`). A guild Outpost (`outpost_<guild>_NN`) is live state, not a seed landmark, so a location naming
one does not resolve. `spawnVehicle` and a dispatch waypoint refuse it, and the `vehicle-location-resolves`
invariant would trip on it. A craft at an Outpost is therefore always on a bare hex, which stays valid when
the row goes. **No normalisation is needed**; a one-line comment in the apply says why, and a tripwire proves it.

**Invariants a reclaim could touch, and why each holds** (all asserted after every reclaim in the tripwires,
and on every tick of the real round trip):
- *Outpost integrity* (`checkOutpostIntegrity`): the row is removed whole, so no dock entry is stranded
  (the gate proved `queue` / `slots` empty). `outpost-serial-monotonic` holds because the serial never goes
  down and the redeploy mints `_02`.
- *Asset occupancy* (`checkAssetOccupancy`): no asset is touched, so `kit-asset-serial-monotonic` is unaffected.
- *Galactic-supply consistency*: the stockpile was empty, and a kit is not a stockpile good. The value does not
  change, and the cache is refreshed across the between-action seam anyway.
- *Craft validity* (`checkVehicleIntegrity`): the location is an in-bounds bare hex that resolves. The hold is
  a known deployable good within capacity (`ASSET_CARGO_VOLUME = HEAVY_HOLD` = the heavy's capacity). There
  is no route, so the `laneEnded` / `deployFailed` "no route" rules hold.
- *Event log* (`checkEventLog`): the type is in the vocabulary, the id comes from the guild's counter, and the
  tick is a whole tick.
- *Conservation* (invariants 1 and 2): no fuel and no credits move.

**Tripwires:** `sim/tests/outpost-teardown.test.js` (31 tests). They cover the happy path; the `loadKit`
parity (byte-identical craft, key order included); stale flags; every refusal separately, each leaving the
state byte-identical; the refusal order; conservation and neutrality on a real founded guild (supply, credits,
fuel, GP, the mean line, the issuance modifier and the entitlement, through the engine's own functions and the
snapshot's fields); the no-op proof; the real round trip (deploy, reclaim, fly, deploy, with invariants on
every tick and a new `_02` id); the notice (payload, copy not alias, `checkEventLog`, snapshot `whenDay`,
`attention`, acknowledge, a refusal writes nothing, two rows with ascending ids, self-contained); a second
reclaim in the same tick; an in-flight Syndicate buy turned back on arrival (`cause: 'outpost-gone'`); the
location finding; `removeOutpost` unchanged; and determinism, save / restore and journal replay.
`sim/tests/events.test.js`'s vocabulary tripwire now lists six types.

**Not built: the client half (§7, slice 2).** The gated Teardown affordance in the Outpost Manager, and the
notice's inbox row and pilot popup with Show on map. **Until it lands,** the current client's notice renderer
treats any type it does not know as a licence lapse, so an `outpost_packed` row would read "Licence lapsed —
…" in MESSAGES. No client control issues a reclaim yet, so only an action posted straight to `POST /action`
can produce one. This is the same interim gap `event-log.md` §10 recorded for `deploy_failed`; the client
slice closes it. *(⤳ Closed 05-10-26 by the client half, §10.)*

## 10. AS-BUILT — the client half (05-10-26; `client/game.html` only, NO `sim/` change)

Built to §2, §7 and §8 and the slice's brief, **no engine change and no new number**. The ruling is kept as written;
this section records what the client does. The roadmap's open call for this slice ("how the button learns whether
the reclaim would pass") was answered by the brief: **option (b)**, the button is always live and the engine's
refusal is shown after the post, as the BUY / SELL gates do. No snapshot field was added.

**Where the Teardown control sits.** In the Outpost Manager's **head**, right-aligned between the Outpost's name
and ✕ (`#omTeardown`). It is shown only when the open Outpost is the player's own (`row.ownerGuildId` equals the
player's `guildId`). It is a quiet button in the manager's own outline style (`.om-act`), with the static hint under it:
"Needs an empty stockpile, nothing docked, and one empty heavy parked here." Why the head: it sits away from the
DOCKED / PARKED tabs (the left column) and the SELL summary (the right hero), and it uses the head's spare width, so
it adds no height. It was first built as a footer under the three columns. That pushed the manager past a
1440×900 screen: the button sat on the bottom edge and a refusal landed below the fold, so a player who pressed
Confirm saw nothing happen. In the head, the whole card fits at 1440×900, and with a refusal showing it grows by
about 34px and still fits. On a phone (≤ 960px) the strip wraps onto its own row under the name, and ✕ stays beside
the name. On anyone else's Outpost the strip is painted empty and `:empty` hides it.

**The gate is the engine's alone (§2).** The client checks nothing: no stockpile, dock or parked-craft test enables
or disables the button. The hint is static copy. A tripwire asserts the Teardown block reads none of the gate's
inputs.

**The flow.**
1. **Teardown** opens an inline confirm in the same place: "Pack up this Outpost?" with Confirm / Cancel. Cancel
   folds it back.
2. **Confirm** sends ONE action through the manager's existing send path:
   `window.__sendAction({ type: 'reclaimOutpost', guildId, outpostId })`, exactly what
   `createReclaimOutpostAction` builds. While the answer is on its way, both buttons are disabled and Confirm reads
   "Packing up…", so a second click cannot send a second reclaim (the SELL's `busy` discipline).
3. **Refused:** the manager stays open, the strip goes back to the Teardown button, and the engine's `reason` is
   shown under the hint **verbatim**. It is never reworded, mapped or truncated. It clears on the next Teardown
   click, on a DOCKED / PARKED tab change, and on close. A network failure reads "the Syndicate could not be
   reached: …", as the SELL's does.
4. **Accepted:** the client re-reads the snapshot (`window.__refreshNow`). The Outpost is gone from it, so the
   manager closes itself through `render`'s existing "no row → `closeManager`" path. The strip stays in its busy
   state until then, so it never flashes back to idle.
5. **Closed or reopened before the answer:** the answer changes nothing in the manager (the SELL's
   `if(OM.sell !== draft) return` guard, here `if(OM.teardown !== t) return`). That includes the auto-open below.

**The auto-open (the brief's UX call, one small block: `openPackedNotice`).** After an accepted teardown and the
refresh, the client finds the newest `outpost_packed` row on the player's guild whose `payload.outpostId` is the
Outpost just packed (its id was captured before sending), and calls `window.__openNotice` with it. If none is
found, nothing opens; the unread row is still in MESSAGES. One consequence: opening the notice is what marks it
read (`event-log.md` §8), so after an auto-open the inbox row is already read. To drop the auto-open, delete
`openPackedNotice` and its one call in `teardownConfirm`.

**The notice.** The inbox row, the pilot popup and Show on map are `event-log.md` §12's client AS-BUILT.

**The refusals as the client shows them**, captured in the browser run below (ids from that run):
- Goods in the stockpile: `Outpost "outpost_raven-guild_01" still holds goods ({"titanium":10}) — empty its
  stockpile first (sell from it, or load the goods out); only an empty Outpost packs into a kit`
- Two craft parked: `2 craft are parked on Outpost "outpost_raven-guild_01" ("vehicle_raven-guild_heavyTransport_01",
  "vehicle_raven-guild_lightTransport_05") — exactly one, an empty heavy transport, may be parked there to pack it
  up; move the others off first`
- A non-heavy parked: `vehicle "vehicle_raven-guild_lightTransport_05" parked on Outpost "outpost_raven-guild_01" is a
  lightTransport — a packed Outpost fills a whole heavy hold, so only a heavy transport can carry it; park an empty
  heavy here instead`
- Nothing parked: `no craft of guild "raven-guild" is parked on Outpost "outpost_raven-guild_01" (hex { q: -9, r: 136 })
  — park an empty heavy transport on this Outpost first; the Outpost is packed into its hold`

**A finding: no player path from a packed heavy to a deploy yet (decision checklist).** §3 says "the player then
dispatches and deploys through the existing flow". The engine does. The client does not: the deploy map opens only
from the Deploy Outpost popup (a kit **asset** in an inventory) and from a `deploy_failed` notice's Redeploy /
Return forks. The ordinary Dispatch → Plan Route planner offers only a dock action per stop, and
`territory-model.md` §5 REVISED removed the heavy-first deploy entry. So a heavy that a teardown has left laden, idle
and un-retreated cannot be sent to deploy by any button today. The pilot's question has no in-game answer yet. The
brief rules a Deploy fork on this notice out of scope, so nothing was added; the browser run reached the redeploy
through the planner's own kit path (`window.__planKitRoute`, the code the Redeploy fork uses) from the console.

**Tripwires:** `sim/tests/outpost-teardown-client.test.js` (18 tests). They cut the page's own code out of
`game.html` and run it in a `node:vm` sandbox with a stub DOM, against a real engine reclaim, its real snapshot and
the engine's real refusal strings: the strip on an own and a rival's Outpost; the button live whatever the gate
would say, and the block reading none of the gate's inputs; the confirm, Cancel, the one action sent in the
engine's own shape, and no double-send; an accept (refresh, self-close, the right notice opened, none when no
match); each of the four everyday refusals shown verbatim and cleared; the tab-change clear; the network failure;
the closed-before-the-answer guard. Plain source checks pin the markup, the listeners, the self-close path and the
CSS. A mutation pass (twelve deliberate breakages of `game.html`, one at a time) turned a test red every time.
One existing tripwire changed: `sim/tests/server.test.js`'s served-bytes check on the delivery notices counted the
notice card's buttons as exactly three ("no new button"). It now counts four, names Show on map, and asserts that
Show on map is gated on `outpost_packed` alone, so a delivery notice still shows Dismiss alone.

**Browser run (headless Chromium, the testbed server, seed 42).** The whole loop was driven in the real page:
found a guild from the splash form; deploy its founding kit through the Deploy Outpost popup and the deploy map;
open the Outpost's manager (the Teardown button and hint); Teardown → the confirm; each of the four refusals above,
staged for real (a Syndicate BUY delivered to the Outpost, a light transport spawned beside the heavy, the heavy
stepped one hex off, the light removed); the heavy back on the Outpost, Teardown → Confirm → the manager closed
and the pilot's popup opened with the verbatim line; Show on map closed the popup and flew to the heavy's hex at
zoom 9; the MESSAGES row; then the redeploy through `__planKitRoute`, which put down `outpost_raven-guild_02`. No
page errors (the only console errors were web-font fetches failing through the sandbox proxy).
**No-op, checked old against new.** `HEAD`'s `game.html` and this one were loaded side by side against the same live
snapshot. Web fonts were blocked in both, and the animated page behind the overlays hidden (the map) or closed (the
Guild Hall), so only the code differed. A rival's Outpost Manager is pixel-identical, at 1440px and 420px wide. The
MESSAGES panel holding a real `deploy_failed` notice is byte-identical HTML. That notice's popup card is
pixel-identical in 10 of 11 runs. The one miss was not diffed. An earlier miss, with the Guild Hall still open behind
the card, was diffed: 41 pixels, all in the card's rounded corners, where the page behind shows through. The card's
HTML differs only by the new hidden Show on map button.

