#!/usr/bin/env bash
# =====================================================================
# Starfare 2.2 - transport AUTOMATION operator demo (run once)
# Rebuilds a seed-42 test galaxy, then drives the whole automation
# ladder and prints a labelled trace of each behaviour.
#
#   >> WARNING: the first step REPLACES the active galaxy (seed 42). 
#
# ---- environment: talks to the container named "starfare"
ADM="docker exec starfare node tools/admin.js"
NODE="docker exec starfare node"
SNAPURL="http://localhost:7331/snapshot"
BASE=""
# ---------------------------------------------------------------------
GUILD=seat_demo
pick(){ $ADM snapshot --pick "$1" $BASE 2>/dev/null; }
tk(){ $ADM tick "$1" $BASE >/dev/null 2>&1; }
# tick forward to just past the next fuel-cycle boundary (+$1 margin)
to_boundary(){ local m="${1:-5}"; local c=$(pick tick); local a=$(pick calendar.dayAnchorTick); local w=$(pick calendar.windowN)
  local n=$($NODE -e 'const t=+process.argv[1],a=+process.argv[2],w=+process.argv[3],m=+process.argv[4];console.log(a+Math.ceil((t-a)/w)*w-t+m)' "$c" "$a" "$w" "$m"); tk "$n"; }
line(){ printf '%s\n' "----------------------------------------------------------------------"; }
banner(){ printf '\n'; line; printf '  %s\n' "$1"; line; }

banner "1. REBUILD  - seed-42 galaxy, guild, craft, outpost, saved route"
$ADM seat-demo --seed 42 $BASE >/dev/null 2>&1
HOME=$(pick guilds.0.homeSystemId)
$ADM adjust-fuel  --guild $GUILD --delta 1000000 $BASE >/dev/null 2>&1
$ADM adjust-goods --guild $GUILD --system $HOME --good titanium --delta 20000 $BASE >/dev/null 2>&1
$ADM spawn-vehicle --guild $GUILD --class mediumTransport --system $HOME $BASE >/dev/null 2>&1
# seat-demo founds a HUMAN guild, which already holds the four starter craft at vehicles.0-3
# (design.md 13, the human founding starter package, 04-10-26), so the medium just spawned is the
# fifth. V is its snapshot path; every read below goes through it.
V=guilds.0.vehicles.4
VID=$(pick $V.id)
SYS=$($NODE -e 'fetch("'$SNAPURL'").then(r=>r.json()).then(o=>{const c=o.claims.find(x=>x.landmarkKind==="system"&&x.ownerGuildId==="'$GUILD'");process.stdout.write(c.landmark.coords.q+","+c.landmark.coords.r)})')
OUT=$($NODE -e 'const q="'$SYS'".split(",");process.stdout.write((+q[0]+1)+","+q[1])')
$ADM spawn-outpost --guild $GUILD --system $HOME --hex $OUT $BASE >/dev/null 2>&1
OID=$(pick outposts.0.id)
ROUTE="sys:$HOME@load:titanium:400; $OUT@unload:titanium:400"
$ADM save-route "Ore run" --guild $GUILD --route "$ROUTE" $BASE >/dev/null 2>&1
printf '  guild=%s  home=%s @ (%s)\n  craft=%s\n  outpost=%s @ (%s)\n  saved routes=%s\n  route: %s\n' \
  "$GUILD" "$HOME" "$SYS" "$VID" "$OID" "$OUT" "$(pick guilds.0.savedRoutes.length)" "$ROUTE"

banner "2. REPEAT + PER-LAP COST  - launch nRun:3, watch the laps run"
$ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" --repeat nRun:3 $BASE >/dev/null 2>&1
printf '  launched nRun:3   mode=%s  N=%s  PER-LAP COST = %s fuel / %s cr\n' \
  "$(pick $V.route.mode)" "$(pick $V.route.N)" \
  "$(pick $V.route.perLapUnits)" "$(pick $V.route.perLapCredits)"
printf '  %-10s %-9s %-14s %s\n' status lapsDone lapsRemaining outpostTitanium
for i in 1 2 3 4 5 6; do
  st=$(pick $V.status); ld=$(pick $V.route.lapsDone)
  lr=$(pick $V.route.lapsRemaining); op=$(pick outposts.0.stockpile.titanium)
  [ -z "$ld" ] && ld="-"; [ -z "$lr" ] && lr="-"; [ -z "$op" ] && op=0
  printf '  %-10s %-9s %-14s %s\n' "$st" "$ld" "$lr" "$op"
  tk 400
done
printf '  -> lane self-ended after 3 laps; craft idle, %s titanium delivered.\n' "$(pick outposts.0.stockpile.titanium)"

banner "3. STOP-AFTER-RUN  - a continuous lane finishes its lap, then ends"
$ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" --repeat continuous $BASE >/dev/null 2>&1
$ADM stop-route-after-run --guild $GUILD --id $VID $BASE >/dev/null 2>&1
printf '  flag set: stopAfterRun=%s\n' "$(pick $V.route.stopAfterRun)"
tk 800
printf '  after its lap: status=%s  route present=%s\n' "$(pick $V.status)" \
  "$([ -z "$(pick $V.route.mode)" ] && echo no || echo yes)"

banner "4. CANCEL  - halt a flying lane at once (snap to hex, keep cargo)"
$ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" --repeat continuous $BASE >/dev/null 2>&1
tk 250
printf '  mid-flight: status=%s\n' "$(pick $V.status)"
$ADM cancel-route --guild $GUILD --id $VID $BASE >/dev/null 2>&1
printf '  cancelled: status=%s  location=(%s,%s)  cargo titanium=%s (loaded, undelivered)\n' \
  "$(pick $V.status)" "$(pick $V.location.q)" \
  "$(pick $V.location.r)" "$(pick $V.cargo.titanium)"

banner "5. REFUSALS  - the engine says no, with a reason"
printf '  cancel an idle craft : '; $ADM cancel-route --guild $GUILD --id $VID $BASE 2>&1 | sed 's/^admin: //'
$ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" --repeat continuous $BASE >/dev/null 2>&1
printf '  dispatch a busy craft: '; $ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" $BASE 2>&1 | sed 's/^admin: //'
$ADM cancel-route --guild $GUILD --id $VID $BASE >/dev/null 2>&1

banner "6. FUEL-SHORT WAITS  - starve a lane, it holds, refuels at the cycle"
to_boundary 5
$ADM dispatch-route --guild $GUILD --id $VID --route "$ROUTE" --repeat continuous $BASE >/dev/null 2>&1
F=$(pick guilds.0.fuelHoard); $ADM adjust-fuel --guild $GUILD --delta $((1 - F)) $BASE >/dev/null 2>&1
tk 700
printf '  starved to 1 fuel (per-lap needs 2): status=%s  waiting.reason=%s\n' \
  "$(pick $V.status)" "$(pick $V.route.waiting.reason)"
$ADM adjust-fuel --guild $GUILD --delta 1000000 $BASE >/dev/null 2>&1
to_boundary 60
w=$(pick $V.route.waiting.reason); [ -z "$w" ] && w="(none - running)"
printf '  after the cycle boundary: waiting.reason=%s  lapsDone=%s\n' "$w" "$(pick $V.route.lapsDone)"

banner "7. TARGET-GONE ENDS  - tear out the stop; the lane drops, craft flagged"
$ADM remove-outpost --guild $GUILD --id $OID $BASE >/dev/null 2>&1
tk 1200
printf '  outpost removed: laneEnded.reason=%s  status=%s  route present=%s\n' \
  "$(pick $V.laneEnded.reason)" "$(pick $V.status)" \
  "$([ -z "$(pick $V.route.mode)" ] && echo no || echo yes)"

banner "DONE  - repeat, per-lap cost, stop, cancel, refusals, fuel-wait, target-gone"
