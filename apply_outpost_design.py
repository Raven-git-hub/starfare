#!/usr/bin/env python3
# design-doc commit: the Guild Outpost (logistics staging). Pure ASCII, self-verifying.
# Run from repo root:  python3 apply_outpost_design.py
import sys, io, os
def die(m):
    sys.stderr.write("REFUSED - " + m + "\n"); sys.exit(1)
P = "docs/design.md"
if not os.path.isfile(P): die("run from repo root: %s not found" % P)
doc = io.open(P, encoding="utf-8").read()

A_OLD = "Outposts are deployable in space purely to extend territory, with no production function;"
A_NEW = "Outposts are deployable in space to extend territory **and to serve as logistics staging** (goods storage + transport docking \u2014 see *The Guild Outpost* below), still with **no production function**;"
B_OLD = "**Resources are system-scoped \u2014 ruling B1.**"
B_NEW = B_OLD + " *(Extended 20-09-26 \u2014 a guild **Outpost** holds a finite stockpile keyed to the Outpost, the one sanctioned home for goods outside a system pool; see \u00a74 *The Guild Outpost*.)*"
ANCHOR = "### Ventures and Ground Assets *(04-08-26)*"

for tag, s in (("A", A_OLD), ("B", B_OLD), ("anchor", ANCHOR)):
    if doc.count(s) != 1: die("anchor %s found %d times (expected 1) - design.md drifted." % (tag, doc.count(s)))
if "### The Guild Outpost" in doc: die("Guild Outpost section already present - refusing to double-apply.")

S = u"""### The Guild Outpost \u2014 a logistics staging structure *(20-09-26)*

A **guild Outpost** is a guild-deployed, single-hex structure \u2014 distinct from the seed's Syndicate **waystations** (which the code also calls "outposts"; \u00a76, \u00a715.4). It is the first destination a young guild builds toward: reachable before territory-claiming is in range, it turns the transport layer into a real load / haul / unload loop. It **evolves** the Section-4 rule to *space = claim/reach **+ logistics**, planet = production*: an Outpost gains storage and transport-handling, but the **production** half is untouched \u2014 an Outpost **produces no goods at any tier**.

**System-like, but finite.** An Outpost holds a **stockpile** and extends the guild's territory/claim, like a system \u2014 but its stockpile has a **hard capacity cap** (unlike a system pool's soft, cost-scaled ceiling, \u00a74). Reaching the cap is a real state: a further unload lands only up to the room remaining (see the dock model). *(Later: an Outpost may also perform craft **maintenance** \u2014 deferred with the maintenance mechanic, not part of this design.)*

**Placed, fixed, destructible.** An Outpost is **buildable and deployable** \u2014 the player chooses its hex (a Tier-4 constructed kit, \u00a75; until that path exists it is operator-spawned, as a vehicle is). It **anchors to a system** (never to another outpost, mirroring the Toll Gate anchor rule, Section 2). It is **infrastructure, not a relocatable ground asset**, so \u00a75's asset-relocatability does **not** apply: **once placed it does not move** (a deliberate simplification). It can be **torn down permanently** (owner or operator). **On destruction its stored goods are destroyed**, and any craft **docked** at it become **idle in space** (bare-hex idle craft) carrying whatever they held at that instant \u2014 which, by the resolve-at-completion rule below, means a loader caught mid-turnaround leaves **empty** ("left it behind") and an unloader leaves **still-laden**.

**Purpose \u2014 a staging post.** An Outpost is a **consolidation point**, typically planted near a Syndicate waystation. Guild transports haul goods from the guild's systems into it; goods may be **sold to the Syndicate *from* the Outpost** (a market-access point), and imports staged there distribute back out to the guild's systems on the guild's own transports. The felt value is **shrinking the distance and time** of Syndicate trade and **consolidating** many small hauls into one forward point. *(Dependency: selling-from-an-Outpost only *means* something if Syndicate selling is **proximity-sensitive** \u2014 \u00a76 currently carries two readings, instant vs a distance-based round-trip; the proximity reading must be settled at the sell-from-Outpost slice, or a near-waystation Outpost buys nothing.)*

**Goods now live in two kinds of place \u2014 an extension of ruling B1 (\u00a715.2).** Until now a guild's goods lived only in a **system pool**. An Outpost adds the **one** sanctioned second home: a finite stockpile **keyed to the Outpost**, not to a system. Everything that reads the guild's goods as a pricing aggregate \u2014 **Galactic Supply** and the Syndicate's supply-derived value (\u00a715.4) \u2014 must count Outpost-held goods too; they are still the guild's goods, just warehoused forward.

**The dock model (load / unload).** "Docking" at an Outpost is the transport analogue of sitting idle at a system, and is deliberately **deadlock-free by construction**:

- An Outpost has a fixed number of **docking slots** (`[FIRST-CUT]` \u2192 `phase-1-tuning.md`; working value 10). A free slot is claimed by **earliest arrival tick first** (deterministic; tie-break on stable id).
- A docked craft serves a **fixed class turnaround** \u2014 light / medium / heavy each cost their own number of ticks (`[FIRST-CUT]` \u2192 `phase-1-tuning.md`) \u2014 and **at the end** of that turnaround its cargo transfer **resolves**: it **loads up to what is available** or **unloads up to the capacity remaining** (a **partial or zero** transfer is a normal outcome), then departs on its next leg. The turnaround is a **departure delay**, not a transfer-in-progress: the goods move at completion, which is exactly why destruction mid-turnaround leaves the transfer un-happened.
- **No craft ever waits *on* anything.** It holds a slot for a fixed span and always departs, so a slot can never be held hostage by an action that cannot complete (empty-stockpile and full-stockpile cases simply resolve as zero / partial). The ten slots are a throughput throttle, never a lock. The **jeopardy** lives in the class turnaround \u2014 a heavy craft ties a slot up far longer, so a long heavy haul is the exposed one.
- **Resolution order**, when several craft finish on the **same** tick and contend for scarce goods or the last of the capacity: by **completion tick**, tie-broken by **arrival tick then stable id**. Docking priority and resolution order are separate rules on purpose \u2014 craft of different classes that dock together finish apart, so a fast craft can finish first and take the goods, and a loader can "miss" a delivery that only completes after it.

**Deferred, but built hub-ready.** An Outpost is designed so it can later become a **Toll-Path hub** \u2014 several of a guild's gates funnelling through it, a craft entering by a gate and choosing one of the outpost's defined exit gates (Section 2 currently treats the hub as emergent geography; formalising it, and the "same gate in and out" spur, is a later slice). Build the entity so a gate can reference it and a route can turn at it \u2014 **do not wire the hub** this pass.

**Numbers deferred.** The dock-slot count, the per-class turnaround times, and the Outpost stockpile cap are all `[FIRST-CUT]` / decision-checklist items (`phase-1-tuning.md`) \u2014 surfaced for a ruling, never invented in code.

"""

doc = doc.replace(A_OLD, A_NEW, 1).replace(B_OLD, B_NEW, 1).replace(ANCHOR, S + ANCHOR, 1)
if doc.count("### The Guild Outpost \u2014 a logistics staging structure *(20-09-26)*") != 1: die("post-check: header not present once.")
if A_NEW not in doc or "*(Extended 20-09-26" not in doc: die("post-check: an amendment did not land.")
io.open(P, "w", encoding="utf-8").write(doc)
print("OK - applied: The Guild Outpost section + 2 rule amendments (space/planet, ruling B1).")
