#!/usr/bin/env python3
# design-doc commit 3: the Guild Outpost CARGO / dock model \u2014 the load/unload mechanic
# + the craft hold + the park/queue/slot/turnaround state machine (design.md \u00a74) and the
# per-class turnaround numbers (phase-1-tuning.md). Pure ASCII, self-verifying, fail-loud.
# Run from repo root:  python3 amend_outpost_cargo.py
import sys, io, os
def die(m):
    sys.stderr.write("REFUSED - " + m + "\n"); sys.exit(1)

DESIGN = "docs/design.md"
TUNING = "docs/phase-1-tuning.md"
for p in (DESIGN, TUNING):
    if not os.path.isfile(p): die("run from repo root: %s not found" % p)
design = io.open(DESIGN, encoding="utf-8").read()
tuning = io.open(TUNING, encoding="utf-8").read()

if "A transport carries goods in a **hold**" in design:
    die("cargo dock model already present in design.md - refusing to double-apply.")
if "OUTPOST_DOCK_TURNAROUND" in tuning:
    die("turnaround numbers already present in phase-1-tuning.md - refusing to double-apply.")

# ---- 1) design.md: replace the old dock-model block (splice between two unique anchors) ----
D_START = '**The dock model (load / unload).** "Docking" at an Outpost is the transport analogue of sitting idle at a system, and is deliberately **deadlock-free by construction**:'
D_END = 'Docking priority and resolution order are separate rules on purpose \u2014 craft of different classes that dock together finish apart, so a fast craft can finish first and take the goods, and a loader can "miss" a delivery that only completes after it.'
for tag, s in (("dock-start", D_START), ("dock-end", D_END)):
    if design.count(s) != 1: die("anchor %s found %d times (expected 1) - design.md drifted." % (tag, design.count(s)))
i0 = design.index(D_START)
i1 = design.index(D_END) + len(D_END)
if not (i0 < i1): die("dock-model anchors out of order - design.md drifted.")

NEW_DOCK = u"""**The dock model (load / unload).** A transport carries goods in a **hold** \u2014 a `good \u2192 int` cargo map capped by its `capacity` (the Syndicate shipment's existing `cargo` shape, \u00a715.4, now on the vehicle). It fills and empties that hold by a **manifest**: an ordered list of `{ load | unload, good, qty }` lines. A manifest reaches a craft two ways over **one** engine mechanic \u2014 **automatically**, carried on its route and fired on arrival, or **manually**, set by the player at the craft and fired on confirm.

**Where it happens decides how.** At a **system**, a transfer is **instant** \u2014 a guild's own territory has unlimited handling, so the manifest resolves the tick it is issued: no slots, no wait. At an **Outpost** it goes through the dock model, deliberately **deadlock-free by construction**:

- A craft that arrives **parks** \u2014 present, idle, **re-dispatchable**, holding **no dock slot**. Any number may park and wait **indefinitely**; a craft with no manifest just orbits until it is given one.
- **A manifest is what makes a parked craft queue** for one of the Outpost's **docking slots** (`OUTPOST_DOCK_SLOTS`, working value 10 \u2192 `phase-1-tuning.md`). Slots throttle **concurrent transfers**, never waiting craft \u2014 so they can't be locked by idle craft (a parked craft holds none), and a craft **in** a slot always finishes in a fixed time and frees it. That is the whole guarantee: **parking is unlimited, slots are for active transfers only.**
- The queue is served by the tick a craft became **ready** (its arrival tick for an auto manifest, its confirm tick for a manual one), tie-broken by stable id \u2014 deterministic.
- In a slot the craft serves a **fixed class turnaround** (`OUTPOST_DOCK_TURNAROUND`, ruled 21-09-26 \u2192 `phase-1-tuning.md`), then its manifest **resolves**, it frees the slot and **returns to orbit** (manual) or **continues its route** (auto). The turnaround is the loading time itself: goods move **at completion**, which is why an Outpost destroyed mid-turnaround leaves the transfer un-happened (a loader leaves empty, an unloader still-laden \u2014 above).

**Resolving a manifest** (instantly at a system, at completion in a slot) runs its lines in a fixed order \u2014 **all unloads first, then all loads** \u2014 each line moving `min(qty, source holds of the good, destination's remaining space)` against the live running totals. It is **partial-safe by construction**: a full hold, a full Outpost (its hard cap), or a good running out each simply clamp the line, and a line that can move nothing moves nothing. Unloads-before-loads is deliberate \u2014 dropping cargo **frees the hold space the loads then use**, so an incomplete unload (a full Outpost: the rare case in good play) **cascades** into a smaller load with no special case. Within each half, lines resolve in their listed order, so two competing for the same limited space are deterministic.

**Cancelling.** A **parked or queued** craft is cancelled by being **re-dispatched** away \u2014 that drops its pending manifest (a parked craft is just idle-at-the-Outpost). A craft **in a slot** (mid-turnaround) runs to completion \u2014 no mid-transfer abort.

**Scope.** A transfer burns **no fuel** \u2014 loading is not movement (\u00a73); only the flight legs burn. Only the **owning guild's** craft dock at an Outpost this slice (shared / leased / rival docking is a later diplomacy concern). The **Syndicate's** own craft never dock or queue \u2014 they bypass the slot model entirely (narrative to arrive with the sell-from-Outpost slice, \u00a76)."""

design = design[:i0] + NEW_DOCK + design[i1:]

# ---- 2) design.md: revise the "Numbers deferred." paragraph (turnaround is now ruled) ----
NUM_OLD = "**Numbers deferred.** The dock-slot count, the per-class turnaround times, and the Outpost stockpile cap are all `[FIRST-CUT]` / decision-checklist items (`phase-1-tuning.md`) \u2014 surfaced for a ruling, never invented in code."
NUM_NEW = "**Numbers.** The Outpost stockpile cap (`30 \u00d7 HEAVY_HOLD`) and the per-class turnaround times (light / medium / heavy, ruled 21-09-26) are **set** \u2192 `phase-1-tuning.md`; the dock-slot count stays the working value 10 (`[FIRST-CUT]`). No constant is chosen in code \u2014 the cap is derived, the rest are sourced there."
if design.count(NUM_OLD) != 1: die("Numbers-deferred paragraph found %d times (expected 1) - design.md drifted." % design.count(NUM_OLD))
design = design.replace(NUM_OLD, NUM_NEW, 1)

# ---- 3) design.md: tweak the destruction wording (parked craft count too, now that park != dock) ----
DES_OLD = "and any craft **docked** at it become **idle in space**"
DES_NEW = "and any craft **at it (parked or docked)** become **idle in space**"
if design.count(DES_OLD) != 1: die("destruction phrase found %d times (expected 1) - design.md drifted." % design.count(DES_OLD))
design = design.replace(DES_OLD, DES_NEW, 1)

# ---- 4) phase-1-tuning.md: add the per-class turnaround numbers before the slice-1 BUILT note ----
T_ANCHOR = "> **BUILT \u2014 the entity + operator spawn/remove, engine + snapshot + operator CLI (2.2, the outpost ladder slice 1).**"
if tuning.count(T_ANCHOR) != 1: die("phase-1-tuning BUILT anchor found %d times (expected 1) - drifted." % tuning.count(T_ANCHOR))
T_BULLET = u"- **`OUTPOST_DOCK_TURNAROUND` \u2014 per-class load/unload time (ticks a craft holds a slot)** \u2014 **RULED 21-09-26** (design.md \u00a74 \"The dock model\"): **light 5, medium 30, heavy 120** ticks. Chosen in real time at the live 1-tick = 1-minute clock (5 min / 30 min / 2 h) and stored as **ticks** (the engine's unit), so if the tick-duration mapping is ever formalised these are the numbers to revisit. It is the whole dock cycle's cost \u2014 one manifest, however many goods \u2014 and **Outpost-only**: a transfer at a guild's own system is instant. It does **not** apply to Syndicate craft (they never dock), and `spycraft` (capacity 0, carries nothing) never transfers. Lives once in `sim/outposts.js`, imported never inlined.\n\n"
tuning = tuning.replace(T_ANCHOR, T_BULLET + T_ANCHOR, 1)

# ---- post-conditions ----
if "A transport carries goods in a **hold**" not in design: die("post-check: new dock block missing.")
if "OUTPOST_DOCK_TURNAROUND" not in tuning: die("post-check: turnaround bullet missing.")
if "**The dock model (load / unload).**" not in design or design.count("**The dock model (load / unload).**") != 1:
    die("post-check: dock-model header not present exactly once.")

io.open(DESIGN, "w", encoding="utf-8").write(design)
io.open(TUNING, "w", encoding="utf-8").write(tuning)
print("OK - applied: design.md dock/cargo model (rewrote the dock block + Numbers para + destruction wording) and phase-1-tuning.md OUTPOST_DOCK_TURNAROUND.")
