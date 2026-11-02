import sys, os

def patch(path, anchor, new_text, mode):
    s = open(path, encoding='utf-8').read()
    if 'outpost-teardown.md' in s:
        sys.exit(f"ABORT: {path} already mentions outpost-teardown.md - already applied?")
    n = s.count(anchor)
    if n != 1:
        sys.exit(f"ABORT: {path}: expected exactly 1 match of anchor, found {n}: {anchor[:70]!r}")
    if mode == 'before':
        s = s.replace(anchor, new_text + anchor, 1)
    else:  # 'after-line': insert new_text after the end of the line the anchor starts
        i = s.index(anchor)
        j = s.index('\n', i) + 1
        s = s[:j] + new_text + s[j:]
    open(path, 'w', encoding='utf-8').write(s)
    print("patched", path)

DESIGN = (
    "\n**Outpost teardown / redeploy — RULED 05-10-26 (roadmap 2.2; `docs/outpost-teardown.md`; design-ahead, NOT BUILT).** "
    "A deployed Outpost can be reclaimed into an Outpost kit aboard a heavy, the inverse of the deploy. This revises "
    "\"once placed it does not move\" above: it still cannot move *as an Outpost*, but it can be packed up and redeployed. "
    "One new action, `reclaimOutpost { guildId, outpostId }`, valid only when (1) the stockpile is empty and nothing is "
    "docked, (2) exactly one own craft is parked on the Outpost's hex and it is an idle heavy with an empty hold, and "
    "(3) it resolves instantly. The Outpost row is deleted and the heavy ends laden with one `outpost_kit` good, idle on "
    "the bare hex, exactly the state `loadKit` leaves; the player then dispatches and deploys through the existing flow. "
    "No kit asset is minted and `kitAssetSerial` is untouched (a kit in a hold has no id); the redeploy takes a fresh "
    "`outpostSerial`, so ids never repeat. It is GP-, mean-line-, fuel- and Galactic-Supply-neutral, and moves no number. "
    "`removeOutpost`'s destroy semantics are unchanged. Territory-era cases (a lost anchor, a rival's parked craft) are "
    "deferred to the territory thread. The reasons, the ordered refusals and the failure modes are in the doc.\n"
)
patch('docs/design.md', '> **BUILT — miner / factory ids never repeat across the operator remove levers', DESIGN, 'after-line')

TERR = (
    "> **RULED 05-10-26 — the reclaim (teardown → redeploy), design-ahead, NOT BUILT.** The inverse of the deploy: a "
    "deployed Outpost with an empty stockpile and nothing docked is packed back into an `outpost_kit` aboard the single "
    "empty heavy parked on its hex, which then re-enters this section's flow unchanged. Full ruling: "
    "`docs/outpost-teardown.md`; `design.md` §4.\n\n"
)
patch('docs/territory-model.md', '## 6. Generation — starter spacing\n', TERR, 'before')

ROAD = (
    "- **2.2 — Outpost teardown / redeploy (the reclaim half of the deploy pipeline; `docs/outpost-teardown.md`).** "
    "RULED 05-10-26, NOT BUILT. Reclaim a deployed Outpost into an `outpost_kit` in the empty heavy parked on its hex, "
    "ready to be dispatched and deployed again. Two slices: the engine action `reclaimOutpost` (the three-rule gate, "
    "the kit into the hold, distinct refusals, tripwires) → a small gated Teardown affordance in the Outpost Manager. "
    "No new number. Out of scope: territory-era cases, kit building, `removeOutpost`'s destroy semantics.\n"
)
patch('docs/roadmap.md', '- **2.2 — The deploy pipeline: the cross-system asset ferry', ROAD, 'before')

def read(p):
    return open(p, encoding='utf-8').read()

def write(p, s):
    open(p, 'w', encoding='utf-8').write(s)
    print("patched", p)

def replace_once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        sys.exit(f"ABORT: {label}: expected exactly 1 match, found {n}: {old[:70]!r}")
    return s.replace(old, new, 1)


if os.path.exists('docs/outpost-teardown.md'):
    sys.exit('ABORT: docs/outpost-teardown.md already exists - already applied?')
DOC = r'''# Outpost teardown / redeploy — reclaiming a deployed Outpost into a kit *(RULED 05-10-26 — design-ahead, NOT BUILT)*

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
'''
open('docs/outpost-teardown.md', 'w', encoding='utf-8').write(DOC)
print('created docs/outpost-teardown.md')

# --- docs/event-log.md ---
p = 'docs/event-log.md'
s = read(p)
if '## 12. The `outpost_packed` notice' in s:
    sys.exit("ABORT: event-log.md already has section 12 - already applied?")
s = replace_once(s,
"are written by a Syndicate BUY to an Outpost — §11, engine and client halves BUILT):",
"are written by a Syndicate BUY to an Outpost — §11, engine and client halves BUILT; a sixth, `outpost_packed`, is written by an Outpost reclaim — §12, RULED, not built):",
"event-log: section 2 vocabulary sentence")
s = s.rstrip('\n') + """

## 12. The `outpost_packed` notice — the reclaim's success message (2.2 Outpost teardown, RULED 05-10-26)

*Status: **RULED, NOT BUILT.** Spec for the notice `docs/outpost-teardown.md` §8 describes. Modelled on §10:
a writer that already holds everything the notice needs records one self-contained row through the shared
`recordEvent`; retention, acknowledge and surfacing are §3–§5's, unchanged. Like §10 it wears a domain
character (the pilot), not the uniform Syndicate voice.*

**The type.** `outpost_packed` — an Outpost was reclaimed into a kit aboard a heavy. Joins `EVENT_TYPES` in
`sim/events.js` so `checkEventLog` accepts it.

**The writer.** The `reclaimOutpost` apply (`sim/actions.js`), after the gate has passed and before the Outpost
row is removed, on the tick the action lands. Born unread.

**The payload** (self-contained; the Outpost is gone by the time it is read):
- `outpostId` — the reclaimed Outpost's id.
- `anchorSystemId` + `anchorSystemName` — the system it anchored to (its seed name, falling back to the id, the
  way §10's `retreatSystemName` resolves).
- `hex` — `{ q, r }`, where the Outpost stood (copied; `cloneEventPayload` already deep-copies a nested hex).
- `craftId` + `craftClass` — the heavy that now carries the kit.

**The surface — the MESSAGES inbox + popup (§8 / §9), the pilot's character, as §10:**
- the inbox row reads **"Outpost packed up"**, newest-first, with the unread dot as any notice;
- the hero is the PILOT (`client/assets/characters/pilot.jpg`), the eyebrow is "Fleet — Dispatch";
- the body is the pilot's voice, verbatim, one beat:

  > The outpost has been packed up, ready to be deployed, Guildmaster. Where do you want me to take it?

- the facts block: `Craft` = `craftClass · NN`; `Packed at` = `anchorSystemName` and hex `{q}, {r}`; `When` = the event
  `whenDay`;
- **one control, SHOW ON MAP**, beside Dismiss. It closes the popup and flies the map to the heavy's CURRENT hex,
  looked up live by `craftId` in the snapshot. A packed heavy sits idle on its hex until the player acts, so
  "current" is normally right; if the heavy is gone, in transit, or not on a hex, fall back to `payload.hex`.
  There is no Deploy or Redeploy button: the message asks the question, and the player answers it through the
  existing dispatch and deploy flow. (§10's Redeploy / Return forks are for a *failed* deploy and are not reused.)

Opening the message acknowledges it (§8, read-on-open), unchanged.

**A NO-OP elsewhere.** A galaxy that never reclaims an Outpost writes no `outpost_packed` row, so every
existing log, snapshot and golden is unchanged.
"""
write(p, s)
