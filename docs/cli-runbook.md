# CLI runbook — exercising the transport automation from the operator side

A repeatable, operator-side check of the **2.2 transport automation layer**
(`transport-model.md` §11): route actions, saved lanes, and repeating runs. It
drives the running server through the operator CLI (`tools/admin.js`) only — no
client, no test harness — and prints a labelled trace of each behaviour.

The one-shot script is **`tools/automation-demo.sh`**. It rebuilds a throwaway
**seed-42** test bed, then demonstrates the whole ladder end to end.

## ⚠️ These commands REPLACE the active galaxy

`seat-demo`, `new-galaxy` and `verify-cycle` all build a galaxy **from scratch**
(`verify-cycle` and `seat-demo` call `new-galaxy` internally): they overwrite the
persisted seed + snapshot and clear the journal. There is **no undo** — the world,
ventures and history that were live are dropped. `verify-cycle` in particular is a
from-scratch self-check, **not** a read-only ledger check. Run the demo (and these
three commands) only on a throwaway galaxy, never on one you want to keep.

## Run it

Against a container named `starfare` (the documented `tools/admin.js` invocation):

    bash tools/automation-demo.sh

The script talks to `docker exec starfare node tools/admin.js`; to point it
elsewhere, edit the four `ADM` / `NODE` / `SNAPURL` / `BASE` lines at its top (e.g.
`ADM="node tools/admin.js"`, `BASE="--base http://host:port"` for a bare-node
server). It derives the guild, home system, the system's hex and the craft id at
runtime, so the only fixed input is `--seed 42`.

## What it proves (each step, in order)

1. **Rebuild** — `seat-demo --seed 42`, a medium transport spawned at home, a guild
   Outpost one hex out, titanium seeded at the home-system cell, one saved route.
2. **Repeat + the per-lap cost** — an `nRun:3` lane; the snapshot's `route` carries
   `mode` / `N` / `lapsDone` / `lapsRemaining` and the recurring `perLapUnits` /
   `perLapCredits` (the point of the layer). Ticks show the lap count climb and goods
   accrue at the Outpost; the lane self-ends idle after three laps.
3. **Stop after this run** — `stop-route-after-run` sets `stopAfterRun`; the lane
   finishes its lap and ends idle at its last stop.
4. **Cancel** — `cancel-route` on a flying lane snaps the craft idle to the hex it is
   over, keeping its loaded-but-undelivered cargo (§11.3, fuel already spent, no refund).
5. **Refusals** — cancelling an idle craft and dispatching a busy one are both refused
   with a clear reason.
6. **Fuel-short WAITS** — a starved lane holds (`waiting.reason: fuel`) and
   auto-resumes at the next fuel-cycle boundary, when the Syndicate disburses fuel
   (§11.6). The script starves inside a fresh cycle so the hold is visible before the
   boundary refuels it.
7. **Target-gone ENDS** — tearing out a stop's Outpost mid-lane drops the route and
   leaves the craft idle where it stopped, flagged `laneEnded: { reason: 'target-gone' }`.

## Reading the snapshot without jq

The container has no `jq`. Read single values with `admin.js snapshot --pick a.b.c`
(arrays index by number, e.g. `guilds.0.vehicles.0.route.perLapUnits`). The guild is
under `guilds[]`, its craft under `guilds.0.vehicles[]`, and territory under the
top-level `outposts` / `claims`.

## The verbs it exercises (all in `tools/admin.js`)

- `dispatch-route --guild ID --id VEHICLE_ID --route "w;w;…" [--repeat once|continuous|nRun:N[:CADENCE]]`
  — a route is `anchor[@load:G:N,…][@unload:G:N,…]`, anchors `sys:<id>` | `out:<id>` | `q,r`;
  `--repeat` makes it a lane (add `:perCycle` for one lap per fuel cycle).
- `save-route "NAME" --guild ID --route "w;w;…"` / `delete-route --guild ID --id ROUTE_ID`.
- `stop-route-after-run --guild ID --id VEHICLE_ID` / `cancel-route --guild ID --id VEHICLE_ID`.
- `spawn-vehicle` / `spawn-outpost` / `remove-outpost` / the `adjust-*` levers / `tick [n]`.
- `grant-kit --guild ID --system ID --kind outpost` / `load-kit --guild ID --id VEHICLE_ID --asset ASSET_ID` /
  `unload-kit --guild ID --id VEHICLE_ID` / `deploy-asset --guild ID --id VEHICLE_ID` — the deploy pipeline
  (next section; not part of the automation demo). `dispatch-route` also takes a last stop
  `q,r@deploy:KIND`, the deploy on arrival (the section after it) — or `sys:<id>@deploy:deepScan`, a Deep Scan
  Array on the centre of a system its guild holds (the Deep Scan Array section) — or `sys:<id>@unload-kit`, the
  unload on arrival (the section after that).

## The deploy pipeline — a kit hauled and deployed (2.2 deploy slice 1)

The operator path for `docs/territory-model.md` §5: mint an Outpost kit into a system's inventory, load it
onto a heavy transport there, fly it out, and deploy it. Since 02-10-26 a kit is an **idle asset** first
(`design.md` §4 — an "idle outpost", `asset_<guild>_outpost_NN`), and reaches a hold only by `load-kit`.
There is no script for this one; the steps are short. On a throwaway galaxy (see the warning above), with
`B="--base http://host:port"` if not the default:

    node tools/admin.js seat-demo --seed 42 $B                    # a guild that holds its home system
    HOME=$(node tools/admin.js snapshot --pick guilds.0.homeSystemId $B)
    node tools/admin.js adjust-fuel --guild seat_demo --delta 100000 $B
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_outpost_01 $B
    node tools/admin.js dispatch-vehicle --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --waypoints "Q,R" $B
    node tools/admin.js tick N $B                                 # N = the arrivalTick dispatch printed, minus now
    node tools/admin.js deploy-asset --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 $B

No spawn or grant is needed: `seat-demo` founds a **human** guild, so it already holds the starter heavy
`vehicle_seat_demo_heavyTransport_01` and the starter kit `asset_seat_demo_outpost_01`, idle at home
(`design.md` §13, the human founding starter package, 04-10-26). To use a fresh pair instead,
`spawn-vehicle --class heavyTransport` and `grant-kit --kind outpost` mint them; the spawn prints the new
craft's id (`_05` here) and the grant the new kit's (`_02`).

`Q,R` is any free bare hex (no system, waystation or Outpost on it) within the outpost deploy range of
the home system (`phase-1-tuning.md` "Territory & deployment"). `deploy-asset` prints the new Outpost's
id, hex and anchor system; the craft is left idle on that hex with an empty hold (it reads as parked at
its new Outpost). Refusals exit 1 with the engine's reason: a load onto anything but an empty, idle heavy
berthed at the kit's own system, a deploy while in flight or while berthed at a system, a deploy on an
occupied hex, or one out of range (the reason names the distance and the nearest held system). A kit
survives a restart, in inventory or in a hold.

**Unload — a kit back into inventory.** A heavy carrying a kit, idle at a system its guild holds, drops it
back as a fresh idle kit asset (a new id — a loaded kit's number never comes back):

    node tools/admin.js unload-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 $B

It is refused on a bare hex, at an Outpost, at a system the guild does not hold, or with anything but
exactly one kit aboard. The guild's idle kits read back as its `assets` rows with `kind: outpost`.

## The deploy on arrival — and the retreat (2.2 deploy slice 2)

The same pipeline without the manual step: the deploy rides the dispatch as the route's last stop,
`q,r@deploy:KIND`, and resolves on the tick the craft lands (`docs/territory-model.md` §5). From the
granted and loaded kit above (on the seed-42 galaxy the home system is at `104,55`):

> **Whose hexes these are.** Every hex in this runbook is the **seed-42 galaxy's** — the one `seat-demo --seed 42`
> *generates* (`POST /admin/galaxy/new` builds the map from that number), where `sys_0006` "BAR-1337" is the home
> at `104,55`. They are not `data/seed.json`'s: the committed reference seed is 7331, and there `sys_0006` is a
> different system at `54,127`. *(⤳ 15-10-26, roadmap 2.5 slice 16: re-derived from a live `seat-demo --seed 42`
> and every command below run once against it — they work as written. Slice 15's checklist had read these hexes
> against `data/seed.json`.)* *(⤳ 15-10-26, roadmap 2.5 slice 17: unchanged by the starter-spacing repair — on seed 42
> it demotes 17 starters, none of them `sys_0006` or `sys_0012`, and moves no coordinate; the deploy, retreat, unload,
> Deep Scan (ring and centre) and scan steps below were re-run live against a fresh `seat-demo --seed 42` and work
> as written.)*

    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "101,55@deploy:outpost" $B
    node tools/admin.js tick N $B                                 # N = firstLegArrivalTick minus now
    node tools/admin.js snapshot --pick outposts $B               # the new Outpost, on 101,55

The dispatch prints the stop as `deploy outpost`. It is refused up front (exit 1, the engine's reason)
unless the deploy would succeed NOW — exactly one matching kit aboard, the hex free, within range of a
held system — and unless it is the route's last stop, on a bare hex, on a one-shot route. On landing the
Outpost is placed and the kit consumed; the craft idles, parked at its new Outpost. Nothing else moves.

**The retreat.** If the hex is taken, or the range lost, while the craft flies, it does not deploy and
does not idle there: it snaps 3 hexes (`DEPLOY_RETREAT_HEXES`) back toward the nearest held system — or
lands AT that system if it is that close — kit still aboard, and carries a `deployFailed` flag. To see
it, occupy the target mid-flight:

    node tools/admin.js dispatch-vehicle --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --waypoints "sys:$HOME" $B
    node tools/admin.js tick N $B                                 # home, empty: a kit loads only in its own system
    node tools/admin.js grant-kit --guild seat_demo --system $HOME --kind outpost $B
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_outpost_02 $B
    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "104,48@deploy:outpost" $B
    node tools/admin.js spawn-outpost --guild seat_demo --system $HOME --hex 104,48 $B   # someone got there first
    node tools/admin.js tick N $B
    node tools/admin.js snapshot --pick guilds.0.vehicles.0.location $B       # {q:104,r:51}: 3 back toward 104,55
    node tools/admin.js snapshot --pick guilds.0.vehicles.0.deployFailed $B   # { reason: occupied, tick }

The snap costs no fuel and no time. The flag clears on the craft's next dispatch, and the kit is still
aboard, so the next dispatch can send it somewhere free — or, once the craft is idle at a held system,
`unload-kit` drops the kit back into that system's inventory (which clears the flag too).

## The unload on arrival — the Return fork (2.2 deploy, asset-initiated slice 3a)

The route-borne `unload-kit`: the last stop `sys:<id>@unload-kit` flies the heavy and its kit to a system the
guild holds and, on the tick it lands, drops the kit into that system's inventory as a fresh idle kit — the
engine half of the `deploy_failed` message's Return fork (`docs/territory-model.md` §5). It is spelled
`unload-kit`, not `unload`, because `@unload:good:qty` is the dock manifest's own segment. From a heavy with a
kit aboard (granted and loaded as above, or left by a retreat):

    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "101,55; sys:$HOME@unload-kit" $B
    node tools/admin.js tick N $B                                 # N = to the last stop's arrival
    node tools/admin.js snapshot --pick guilds.0.vehicles.0 $B    # idle at $HOME, hold {}
    node tools/admin.js snapshot --pick guilds.0.assets $B        # a fresh asset_seat_demo_outpost_NN in $HOME

The dispatch prints the stop as `unload kit`. It is refused up front (exit 1, the engine's reason) unless the
unload would succeed NOW (exactly one kit aboard and nothing else, at a system the guild holds) and unless it is
the route's last stop, a system (not a bare hex or an Outpost), on a one-shot route with no deploy. The new kit
takes the next number from the guild's kit serial, so a kit that went out as `_01` comes back as `_02`. A route
of the one stop the craft is already at (`--route "sys:$HOME@unload-kit"`) unloads at once, burning no fuel,
like the standalone `unload-kit`. If the target were no longer held when the craft lands (no play path does this
today), the kit would stay aboard and the craft would idle there flagged `laneEnded: { reason: 'target-gone' }`.

## The Deep Scan Array — a kit deployed "attached" (2.5 (b1))

The second space-lane kind (`docs/exploration-model.md` §5): the same grant → load → fly → deploy, with the
kind `deepScan` and a different placement rule. The array must go on a bare hex **touching** territory the
guild holds — exactly `claimRadius + 1` hexes from a held system's centre (the ring just outside its control
disk; `claimRadius` is in the seed, 1 for every system today), or 1 hex from one of the guild's own Outposts.
There is no range number. It scans nothing yet (slice (b2)). *(⤳ REVISED 15-10-26, roadmap 2.5 slice 15: a bare hex
INSIDE the guild's own disk is legal too, and any hex inside a RIVAL's control is refused — exit 1,
"is inside guild … 's territory"; a route whose target becomes a rival's while it flies retreats with
`deployFailed: { reason: 'rival-territory' }`. `docs/exploration-model.md` §5.)* On a fresh seat-demo galaxy (home
`sys_0006` at `104,55`, so `105,55` is inside its disk, `106,55` is on the ring and `107,55` is one hex past it):

    node tools/admin.js seat-demo --seed 42 $B                    # fresh: the heavy idle and empty at home
    HOME=$(node tools/admin.js snapshot --pick guilds.0.homeSystemId $B)
    node tools/admin.js adjust-fuel --guild seat_demo --delta 100000 $B
    node tools/admin.js grant-kit --guild seat_demo --system $HOME --kind deepScan $B    # prints the minted asset id
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_deepScan_02 $B
    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "106,55@deploy:deepScan" $B
    node tools/admin.js tick N $B                                 # N = to the arrival; the array is placed on it
    node tools/admin.js snapshot --pick deepScanArrays $B         # the god's-eye rows

The grant names the kit `_02` because the kit serial is shared by every kit kind, and a fresh seat-demo guild
already holds the starter Outpost kit `_01`; after the sections above it prints a later number, so load the one it
printed. Or fly there with `dispatch-vehicle` and place it by hand with `deploy-asset`, which prints the new array's
id (`deepScanArray_<guild>_NN`), hex and anchor system. A hex that does not touch the guild's territory is refused,
up front for a route, at once for `deploy-asset` (exit 1, "touches no footprint guild … holds" — *⤳ slice 15: "is in or
beside no territory guild … holds"*); so is one inside the disk (*⤳ no longer — slice 15*), an occupied hex (one structure per hex, Outposts and arrays alike), and a deploy whose waypoint
kind does not match the kit aboard. A route whose attachment is lost while it flies (the Outpost it touched was
packed up) retreats exactly as an Outpost deploy does, flagged `deployFailed: { reason: 'not-attached' }`.
`grant-kit`, `load-kit` and `unload-kit` list the guild's idle kits of every kind.

**On the home system's own centre (2.5 slice 16).** An array may also stand on the centre hex of a system its guild
holds — the one exception to "a deploy lands on a bare hex", for arrays only (`docs/exploration-model.md` §5,
AMENDED 15-10-26). The last stop is then the **system** itself, so the craft ends berthed there and the array's hex
is the system's centre, `104,55`, anchored to it. From a heavy back at home with a fresh array kit aboard:

    node tools/admin.js dispatch-vehicle --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --waypoints "sys:$HOME" $B
    node tools/admin.js tick N $B                                 # home again, empty
    node tools/admin.js grant-kit --guild seat_demo --system $HOME --kind deepScan $B    # _03
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_deepScan_03 $B
    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "sys:$HOME@deploy:deepScan" $B
    node tools/admin.js snapshot --pick deepScanArrays.1 $B       # deepScanArray_seat_demo_02 on 104,55, anchored sys_0006

The heavy is already at that stop, so the route acts in place: the array is planted on the dispatch tick, no fuel
burns, and the heavy stays idle, berthed at home. (`deploy-asset` from a heavy berthed at home does the same by
hand; from anywhere else the route flies to the system and plants it on landing, re-checked on arrival.) A second
array on the same centre is refused (exit 1, "already occupied by deepScanArray …"), and so is an **Outpost** kit
sent to any system ("is a landmark … an Outpost deploys on a bare hex"), a system nobody holds or a waystation
("… deploys on a bare hex, or on the centre of a system its guild holds"), and a rival's system ("is inside guild
… 's territory").

A guild sees only its OWN arrays: `GET /snapshot?guild=<id>` carries `deepScanArrays` with that guild's rows
only, and no `deepScanArrays` key at all when it owns none; a rival's array is not in the view.

### The scan (2.5 (b2))

A deployed array runs ONE scan job at a time (`docs/exploration-model.md` §5): an **L1** system scan (720
ticks — every planet's archetype, no node) or an **L2** planet scan (480 ticks — that planet's resource
nodes, legal only once its archetype is known). Targets must be unclaimed. There is no `tools/admin.js`
command for it; post the action to the server directly (`$U` is the server's base URL):

    curl -s -X POST $U/action -d '{"type":"queueScan","guildId":"seat_demo","arrayId":"deepScanArray_seat_demo_01","level":"L1","targetSystemId":"sys_0012"}'
    node tools/admin.js tick 720 $B
    curl -s "$U/snapshot?guild=seat_demo"      # geography.known.sys_0012: every planet's archetype, nodes {}
    curl -s -X POST $U/action -d '{"type":"queueScan","guildId":"seat_demo","arrayId":"deepScanArray_seat_demo_01","level":"L2","targetPlanetId":"pl_00048"}'
    node tools/admin.js tick 480 $B            # geography.known.sys_0012.pl_00048.nodes: all of them

While it runs, the owner's array row carries `scan: { level, targetSystemId | targetPlanetId, startedTick,
completeTick }`; it reveals at the end of tick `completeTick` and the key goes. Refused with a reason: a second
job on a busy array, a rival's system ("espionage (L3), not built"), your own ("your own ground"), an L2 on a
planet whose archetype is unknown. If a rival claims the target before the job completes, it completes to
nothing. The operator removes an array — and with it any running job, which then never reveals — with:

    curl -s -X POST $U/action -d '{"type":"removeDeepScanArray","guildId":"seat_demo","arrayId":"deepScanArray_seat_demo_01"}'

(The ids above are seed 42's: the array deployed on `106,55`, and `sys_0012` / `pl_00048` an unclaimed system
and one of its planets.)

## The claim act — a Prefecture ferried and planted (2.5, the Prefecture / claims slice, engine PR 1)

The operator path for `docs/territory-model.md` §4: a guild takes a second system. A Prefecture kit is ferried into
an **unclaimed** system on a route ending in `@unload-kit` (the one kit that may unload into ground its guild does
not hold — never a rival's), then planted on a settlement slot of a planet the guild has **surveyed to full L2**. The
plant writes the system claim. On the seed-42 galaxy, from a fresh `seat-demo --seed 42` (`sys_0936` is the nearest
non-starter system to the home `sys_0006` with a settlement slot, 8 hexes out; `pl_03280` one of its planets):

    node tools/admin.js adjust-fuel --guild seat_demo --delta 100000 $B
    node tools/admin.js grant-kit --guild seat_demo --system sys_0006 --kind prefecture $B       # asset_seat_demo_prefecture_02
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_prefecture_02 $B
    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "sys:sys_0936@unload-kit" $B
    node tools/admin.js tick 1800 $B                              # to firstLegArrivalTick; the kit lands as asset_seat_demo_prefecture_03 in sys_0936
    node tools/admin.js reveal --guild seat_demo --planet pl_03280 $B                            # the survey (or a Deep Scan Array's L1 + L2 scans)
    node tools/admin.js plant-prefecture --guild seat_demo --asset asset_seat_demo_prefecture_03 --slot pl_03280_s01 $B

`plant-prefecture` prints the Prefecture (`prefecture_seat_demo_01`), the claim it wrote (`claim_prefecture_seat_demo_01`,
at the plant's tick) and the systems the guild now holds (`sys_0006, sys_0936`). From then on the guild may establish
ventures in `sys_0936` (Gate 3), and the slot reads as occupied. Refusals exit 1 with the engine's reason, checked in
this order: not an idle Prefecture kit of this guild; not a settlement slot in the kit's own system; the planet not
surveyed ("has not surveyed planet …" — try it before the `reveal`); the slot occupied; the system held by anyone (a
rival, or the guild itself — its home included). A dispatch whose unload target a rival already holds is refused up
front; if a rival claims it while the heavy flies, the heavy RETREATS with the kit aboard, flagged `deployFailed:
{ reason: 'system-claimed' }`, with a `deploy_failed` notice — the outpost's retreat. A kit can also be **built**: the
dockyard's commission dropdown now lists the Prefecture (14 days), and the Syndicate refuses to sell one. *(Run live
16-10-26 against a fresh `seat-demo --seed 42`, and the plant survived a server restart with persistence on.)*

## Losing ground — a Prefecture abandoned (the destroyed path, engine PR 1)

The operator path for `docs/territory-model.md` §4's "AS-BUILT — losing ground, engine PR 1" (`design.md` §19 #67 /
#69): the guild abandons a Prefecture, which is **destroyed** — no kit comes back — and the system goes **fallow**.
Continuing from the plant above (the guild holds `sys_0936`), give it something to lose — a factory on the planet's
second slot and some goods in the system's pool — then abandon:

    node tools/admin.js grant-asset --guild seat_demo --kind factory --system sys_0936 $B                  # asset_seat_demo_factory_11
    curl -s -X POST $U/action -d '{"type":"establishVenture","guildId":"seat_demo","ventureId":"f936","ventureType":"refining","siteId":"pl_03280_s02","assetId":"asset_seat_demo_factory_11","recipeId":"titanium_alloy"}'
    node tools/admin.js adjust-goods --guild seat_demo --system sys_0936 --good titanium --delta 30 $B
    node tools/admin.js abandon-prefecture --guild seat_demo --id prefecture_seat_demo_01 $B

`abandon-prefecture` prints what the eviction did, read off the guild's own `system_lost` notice: the system lost
(`sys_0936 (BAR-7159) — now unclaimed`, its claim removed), the ventures torn down (`f936` — each also gets a
`venture_closed` notice, cause `evicted`, and no settlement fee), the machines left **stranded** awaiting salvage
(`asset_seat_demo_factory_11` — still idle in `sys_0936`, its asset row now carrying `stranded: { tick }`), the goods
forfeit (`titanium 30` — the pool's key is gone, and Galactic Supply is lower by exactly that), and the systems the guild
still holds (`sys_0006`). Its exploration record is untouched. Refusals exit 1 with the engine's reason: no such
Prefecture (the same one twice included — destroyed is destroyed), a rival's, and — while one of the guild's heavies is
flying a Deep Scan Array to deploy on that system's centre — "let it land, or re-dispatch it". The home can never be
abandoned: founding gives it no Prefecture to name. Until the sweep slice lands, another guild's `plant-prefecture` in
`sys_0936` is refused while the stranded factory lies there ("awaiting salvage"); the guild's own re-plant there
recovers it. *(⤳ 28-10-26 — the sweep is built (losing ground, engine PR 4): another guild's `plant-prefecture` in
`sys_0936` is now ACCEPTED and takes the stranded factory, which becomes that guild's own idle factory under a new id,
with an `assets_inherited` notice to it and an `assets_swept` notice to `seat_demo`. `plant-prefecture` still prints
only the claim, not what it inherited — read the guild's notices. The engine's tests prove it; this was not re-run live.)* *(Run live 17-10-26 against a fresh `seat-demo --seed 42` continuing from the plant above, and the
abandon survived a server restart with persistence on.)*

## Salvage — a stranded machine hauled home (losing ground, engine PR 2)

The operator path for `docs/territory-model.md` §5's "AS-BUILT — losing ground, engine PR 2" (`design.md` §19 #67): the
**salvage run**, the cross-system asset ferry exposed salvage-only. Continuing from the abandon above, the heavy that
ferried the Prefecture kit is still berthed in the now-fallow `sys_0936`, beside the stranded factory. Load the factory,
fly it home on an ordinary dispatch, and unload it there:

    node tools/admin.js salvage-load --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_factory_11 $B
    node tools/admin.js dispatch-vehicle --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --waypoints "sys:sys_0006" $B
    node tools/admin.js tick 1800 $B                              # home again (8 hexes), the factory still aboard
    node tools/admin.js salvage-unload --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 $B

`salvage-load` prints the machine now aboard — `asset_seat_demo_factory_11 (factory), loaded in sys_0936 — in transit on
vehicle_seat_demo_heavyTransport_01` — and the hold, `locked by asset_seat_demo_factory_11 (6000000 / 6000000 space)`: a
machine fills a whole heavy hold. Its `stranded` flag is gone (in hand, it is no longer awaiting salvage), and its asset
row reads `inTransitOnVehicleId` instead. The dispatch is the ordinary one — the heavy burns its own fuel per hex, as it
would empty. `salvage-unload` prints `asset_seat_demo_factory_11 (factory) — idle in sys_0006` and `hold empty`: the
factory's `systemId` is now the home system, where `establishVenture` can seat it like any idle factory. Refusals exit 1
with the engine's reason: a machine that is not stranded (`asset_seat_demo_miner_01`, a healthy home miner — "is not
stranded"; moving a machine between held systems is not built); an unload while the heavy carries nothing; an unload still
berthed at the fallow `sys_0936` ("does not hold system"); a second machine onto a laden heavy ("the hold is locked"). While
laden, the heavy also refuses `transfer-cargo`, `load-kit`, any route action and a repeating lane. There is no salvage
window yet — its rate is unset — so a stranded machine waits until it is salvaged. *(Run live 27-10-26 against a fresh
`seat-demo --seed 42` continuing from the abandon above, and the salvaged factory survived a server restart with
persistence on.)*
