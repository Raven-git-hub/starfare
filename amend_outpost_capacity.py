#!/usr/bin/env python3
# design-doc commit 2: the Guild Outpost CAPACITY model (cargo-space stockpile,
# idle-asset storage, 30x HEAVY_HOLD cap). Pure ASCII, self-verifying. Repo root:
#   python3 amend_outpost_capacity.py
import sys, io, os
def die(m):
    sys.stderr.write("REFUSED - " + m + "\n"); sys.exit(1)
P = "docs/design.md"
if not os.path.isfile(P): die("run from repo root: %s not found" % P)
doc = io.open(P, encoding="utf-8").read()

if "### The Guild Outpost" not in doc: die("Guild Outpost section missing - apply the first design commit before this one.")
if "Capacity \u2014 measured in cargo space" in doc: die("capacity paragraph already present - refusing to double-apply.")

ANCHOR = "**The dock model (load / unload).**"
if doc.count(ANCHOR) != 1: die("dock-model anchor found %d times (expected 1) - design.md drifted." % doc.count(ANCHOR))

PARA = (u"**Capacity \u2014 measured in cargo space, not unit count.** An Outpost's finite stockpile is measured in "
        u"**cargo volume**, exactly as a transport hold is: stored goods consume `\u03a3 qty \u00d7 volumeOf(good)` (so each "
        u"good carries its own per-unit volume by tier), the same `volumeOf` / `HAULER_TIERS` machinery the trade "
        u"layer and transports already use. Beyond goods, an Outpost may also **store idle deployable assets it "
        u"cannot deploy** \u2014 miners, factories, deep scanners, toll gates, and undeployed Outpost kits \u2014 each "
        u"consuming cargo space by the same rule (a ground asset already carries `ASSET_CARGO_VOLUME = HEAVY_HOLD`; "
        u"the not-yet-built kinds' per-kind volumes are TBD \u2192 `phase-1-tuning.md` / decision checklist). Storage "
        u"only: an Outpost is **not** a deploy site (it produces nothing, \u00a74), so putting a stored asset to work "
        u"means hauling it out to where it deploys. The **hard cap is 30 \u00d7 `HEAVY_HOLD`** \u2014 thirty heavy-hauler "
        u"holds (ruled 20-09-26 \u2192 `phase-1-tuning.md`); since one asset fills one heavy hold today, that is ~30 "
        u"stored assets, or the goods-volume equivalent, mixed freely. *(Deferred to the asset-storage slice: idle "
        u"assets gaining a **location** at an Outpost \u2014 today an idle asset has none \u2014 and the per-kind volumes "
        u"above; this ruling fixes the model, not the build.)*\n\n")

doc = doc.replace(ANCHOR, PARA + ANCHOR, 1)
if doc.count("Capacity \u2014 measured in cargo space, not unit count.") != 1: die("post-check: capacity paragraph not present once.")
io.open(P, "w", encoding="utf-8").write(doc)
print("OK - applied: Guild Outpost capacity paragraph (cargo-space stockpile + idle-asset storage + 30x HEAVY_HOLD cap).")
