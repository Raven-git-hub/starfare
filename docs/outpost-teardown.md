# Outpost teardown / redeploy — reclaiming a deployed Outpost into a kit *(RULED 05-10-26 — design-ahead, NOT BUILT)*

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
- The player then dispatches and deploys through the existing flow.

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
