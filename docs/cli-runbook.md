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
  `q,r@deploy:KIND`, the deploy on arrival (the section after it), or `sys:<id>@unload-kit`, the unload on
  arrival (the section after that).

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
granted and loaded kit above (on seed 42 the home system is at `104,55`):

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
There is no range number. It scans nothing yet (slice (b2)). On the seat-demo galaxy above (home `sys_0006`
at `104,55`, so `106,55` is on the ring and `107,55` is one hex past it):

    node tools/admin.js grant-kit --guild seat_demo --system $HOME --kind deepScan $B    # prints the minted asset id
    node tools/admin.js load-kit --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --asset asset_seat_demo_deepScan_02 $B
    node tools/admin.js dispatch-route --guild seat_demo --id vehicle_seat_demo_heavyTransport_01 --route "106,55@deploy:deepScan" $B
    node tools/admin.js tick N $B                                 # N = to the arrival; the array is placed on it
    node tools/admin.js snapshot --pick deepScanArrays $B         # the god's-eye rows

or fly there with `dispatch-vehicle` and place it by hand with `deploy-asset`, which prints the new array's id
(`deepScanArray_<guild>_NN`), hex and anchor system. A hex that does not touch the guild's territory is refused,
up front for a route, at once for `deploy-asset` (exit 1, "touches no footprint guild … holds"); so is one
inside the disk, an occupied hex (one structure per hex, Outposts and arrays alike), and a deploy whose waypoint
kind does not match the kit aboard. A route whose attachment is lost while it flies (the Outpost it touched was
packed up) retreats exactly as an Outpost deploy does, flagged `deployFailed: { reason: 'not-attached' }`.
`grant-kit`, `load-kit` and `unload-kit` list the guild's idle kits of every kind.

A guild sees only its OWN arrays: `GET /snapshot?guild=<id>` carries `deepScanArrays` with that guild's rows
only, and no `deepScanArrays` key at all when it owns none; a rival's array is not in the view.
