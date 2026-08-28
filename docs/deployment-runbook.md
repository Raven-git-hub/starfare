# Starfare — deployment runbook (game container behind starfare-1.online)

> **Updated 2026-08-27.** The container runs the **galaxy-lifecycle** build (create/delete a galaxy at
> runtime from the admin panel; the seed lives in the volume; a boot clock ticks the world once a
> minute). Host facts, learned in the field: the repo clone is `~/starfare` and state lives at
> `~/starfare-state` on the Docker host (`docker@docker`) — substitute your host's actual paths; and
> **the tunnel connector needs `--protocol http2`** (this network drops QUIC after the handshake). The
> run command carries **`-e STARFARE_TICK_MS=60000`** (one tick/minute), and every redeploy ends with
> **`docker image prune -af`** — see **Disk hygiene** (section 11), which a full disk made non-optional.
> Ops is now a **command, not a paste**: `tools/admin.js` ships in the image, and
> **`docker exec starfare node tools/admin.js verify-cycle`** is the standard post-redeploy check
> (section 12).

**What this deploys:** the persistence-capable game container — one galaxy, in-memory compute,
file-backed durability, runtime create/delete of the galaxy, a self-ticking world — reachable at
**https://starfare-1.online** through a **Cloudflare Tunnel**, gated by **Cloudflare Access** (email
allow-list). No inbound ports on your host.

**What this is NOT:** the Phase-2 multi-user server or a Postgres deployment. Still the dev-rig engine,
now durable, reachable, self-ticking, and played through the polished client with a real admin panel.

> **Why this shape.** The container publishes **zero** host ports. `cloudflared` dials **out** and
> forwards traffic in over a private Docker network; Cloudflare Access sits in front and demands your
> login before any request reaches the app. That neutralises the rig's open `/admin/*`, `/reset`,
> `/action` endpoints without a code change — nobody but you can reach them.

## 0. Prerequisites (one-time)

    # On the Docker host (docker@docker):
    docker --version
    git -C ~/starfare log --oneline -1   # the tip you intend to ship

Cloudflare (one-time, dashboard): `starfare-1.online` is an **Active** zone in your account; you can
reach **Zero Trust**. Free plan covers everything here.

## 1. Build the image

    cd ~/starfare
    NEW=$(git rev-parse --short HEAD)
    docker build -t starfare-rig:$NEW -t starfare-rig:latest .

Two tags: `:$NEW` pins exactly what shipped, `:latest` is the run handle. Re-tag every deploy.

## 2. Durable state directory

    mkdir -p ~/starfare-state

This is the one piece of durable state on the box. The **active galaxy** — `seed.json` + `state.json` +
`journal.jsonl` — lives here and survives `docker rm`, rebuilds, and reboots. Back *this* up.

## 3. Private network (one-time)

    docker network create starfare-net

## 4. Run the app container (no published ports)

    docker run -d \
      --name starfare \
      --network starfare-net \
      --restart unless-stopped \
      -e STARFARE_PERSIST_DIR=/data \
      -e STARFARE_TICK_MS=60000 \
      -v "$HOME/starfare-state:/data" \
      --stop-timeout 30 \
      starfare-rig:latest

The load-bearing flags:
- **no `-p`** — the app is on no host port; only `starfare-net` (i.e. `cloudflared`) reaches it.
- **`-e STARFARE_TICK_MS=60000`** — the boot clock: one tick per minute, the world turns on its own from
  the moment a galaxy exists, regardless of players/bots. Env vars don't survive `docker rm`, so
  **re-pass this every run** or the clock reverts to manual. (Operator config, not a game number.)
- `-e STARFARE_PERSIST_DIR=/data` + `-v …:/data` — durability on, pointed at the mounted host dir.
- `--restart unless-stopped` — survives reboots/crashes; journal replay recovers actions since the last
  snapshot.
- `--stop-timeout 30` — room for the SIGTERM save-and-clear before SIGKILL.

Check it came up: `docker logs starfare --tail 20`
- **Fresh / empty volume:** `[clock] ARMED at 60000 ms — waiting for a galaxy`, `galaxy: NO GALAXY`.
  Correct — a seedless volume boots to **NO-GALAXY**; you create the first galaxy from the admin panel
  (section 8), not from a baked default.
- **Volume with a galaxy:** `[persist] loaded state @tick N`, `galaxy: active`, `[clock] ON …` — the
  existing world restores and keeps ticking.

## 5–7. Tunnel + Access

Zero Trust → **Networks → Tunnels → Create** (`starfare`), copy the token, add Public Hostname
`starfare-1.online` → Service `HTTP` `starfare:7331`. Run the connector:

    umask 077 && printf 'TUNNEL_TOKEN=%s\n' 'eyJ...PASTE_TOKEN...' > /root/starfare-tunnel.env
    docker run -d --name starfare-tunnel --network starfare-net --restart unless-stopped \
      --env-file /root/starfare-tunnel.env \
      cloudflare/cloudflared:latest tunnel --no-autoupdate --protocol http2 run
    docker logs starfare-tunnel --tail 20     # expect "Registered tunnel connection" (~4x)

> **`--protocol http2` is load-bearing on this host** — QUIC loops on `control stream … failure`.

Then **gate it with Access before sharing the URL**: Zero Trust → Access → Applications → Add →
Self-hosted → `Starfare`, hostname `starfare-1.online`, policy `me` → Allow → Emails →
`andrew_n_gleave@pm.me`.

## 8. First light — create the galaxy from the admin panel

Open **https://starfare-1.online/** → Access login → the player portal. On a fresh volume it shows a
calm **waiting** state. To open a galaxy:
1. Go to **https://starfare-1.online/inspect** (the operator **admin panel** — unlinked, Access-gated).
   It shows **NO GALAXY** with a seed field and **CREATE GALAXY** / **DELETE GALAXY**.
2. Type a seed number (or leave blank to randomise), and — if this galaxy's day should **not** roll
   at UTC midnight — a **UTC offset in hours** (`+8`, `+5.5`, `-3`; blank is UTC). Then
   **Create Galaxy** → confirm. The strip flips to **ACTIVE — SEED ####**, tick climbing once a
   minute; the 10 Syndicate claims re-plant on that seed.
   The offset is **frozen with the galaxy** (cycle-and-calendar.md §2a): it decides which midnight
   the commitment cycle rolls on and which local time the HUD and this panel display, and the only
   way to change it is to create another galaxy. It is a **fixed** offset — it does not follow
   daylight saving.
3. Back on `/`, the waiting player connects on its own → onboard onto an unsettled starter.

Prove persistence: `docker kill starfare && docker start starfare` then `docker logs starfare --tail 10`
→ `[persist] loaded state @tick N` — same galaxy restored.

## 9. Day-2 — redeploy new code (the standard loop)

    cd ~/starfare && git pull
    NEW=$(git rev-parse --short HEAD)
    docker build -t starfare-rig:$NEW -t starfare-rig:latest .
    docker stop starfare && docker rm starfare
    docker run -d \
      --name starfare \
      --network starfare-net \
      --restart unless-stopped \
      -e STARFARE_PERSIST_DIR=/data \
      -e STARFARE_TICK_MS=60000 \
      -v "$HOME/starfare-state:/data" \
      --stop-timeout 30 \
      starfare-rig:latest
    docker image prune -af          # reclaim the now-unused old image (see section 11)
    docker logs starfare --tail 15

The state dir is untouched by the rebuild, so **the active galaxy carries across** — the boot log reads
`loaded state @tick N` / `galaxy: active`, and the tick continues. No reset, no re-onboarding.

**Start a fresh galaxy** is now an admin action, not `/reset`: on `/inspect`, **Delete Galaxy** (→
NO-GALAXY) then **Create Galaxy**, or **Create** over the active one (it replaces it, behind the
confirm). `POST /reset` still exists but the lifecycle controls are the intended path.

**Back up the world:** `cp -a ~/starfare-state ~/starfare-state.$(date +%F)`.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Boot loops on **`[persist] REPLAY HALT`** | Snapshot + stale same-tick journal both survived. Snapshot wins: `rm ~/starfare-state/journal.jsonl` then `docker start starfare`. |
| **`No space left on device`** on `git pull` or `docker build` | Disk full — see **section 11**. Deletes still work while writes fail: prune, then retry. |
| Tunnel loops on **`control stream … failure`**, no `Registered` lines | Network drops QUIC. Re-create the connector with **`--protocol http2`**. |
| Tunnel **HEALTHY** but page 502s | App not reachable at `starfare:7331`. Check both containers are on `starfare-net` and the app is up. |
| `/inspect` shows the OLD console / no CREATE control | The running container is behind the code. Redeploy (section 9) and confirm the boot log matches. |
| Old planet-tab / HUD after redeploy | Browser cache — hard-refresh (Ctrl/Cmd-Shift-R). |

## 11. Disk hygiene (added 2026-08-25 — a full disk stopped a deploy)

The host filled to **100%** (31 GB) mid-deploy: `docker system df` showed **~24 GB of images, ~22 GB
reclaimable**. Cause: every deploy tags a new `starfare-rig:<sha>` (plus `:latest`), and the old
**tagged** `:<sha>` images are never removed by a dangling-only prune, so they stack until the disk
fills. A full disk fails `git pull` and `docker build` (writes fail; the old `:latest` then relaunches,
so it looks "up" on the *old* image — a trap).

**Routine (folded into section 9):** `docker image prune -af` after each successful deploy drops the
now-unused old image immediately.

**When the disk has already climbed:**

    df -h /                         # if Use% is high / Avail ~0
    docker system df                # see where it went (Images is usually the hog)
    docker container prune -f       # remove stopped containers first (frees their image refs)
    docker image prune -af          # remove unused images  (the big reclaim)
    docker builder prune -af        # clear the build cache
    df -h /                         # confirm headroom before retrying the deploy

These are safe: the running `starfare` + `starfare-tunnel` and their images are protected.

**Stray containers — investigate once.** During the incident `docker system df` reported **12
containers, 10 "active"** where only two should run (`starfare`, `starfare-tunnel`). Something leaves
containers behind across deploys. Run `docker ps -a`, remove strays (`docker container prune -f` for
stopped ones; kill/remove unexpected running ones by name), and if they keep reappearing find what
starts them (a leftover smoke-test `docker run`, a compose file, a duplicate `--name`).

## 12. Operator commands — `tools/admin.js` (added 2026-08-27)

Operating and verifying the live container used to mean pasting a browser-console blob or a hand-rolled
`curl`/`node` snippet — fragile (it lands in the wrong shell) and unversioned (it lived in a chat
message). `tools/admin.js` is the committed replacement: a **dependency-free** Node CLI that ships in
the image and turns each recurring chore into a labelled shell command. It is a **thin HTTP client**
over the endpoints `sim/server.js` already serves — it drives the running game, it does not embed the
engine, and it computes no game number.

    docker exec starfare node tools/admin.js <command> [flags]

It runs in the stock `node:22-alpine` image with nothing installed (plain Node + global `fetch`), and
`--base` defaults to `$STARFARE_BASE` or `http://localhost:7331`, so the same commands work unchanged
against a local `node sim/server.js`:

    node tools/admin.js verify-cycle --base http://localhost:7331

**Exit codes:** `0` on success, `1` on failure — including a refused action (`{accepted:false}`), a
`NO GALAXY` server, or a failed `verify-cycle`. Scriptable and CI-able.

| Command | Endpoint(s) it wraps | What it does |
|---|---|---|
| `health` | `GET /health` | Liveness, galaxy state + seed, tick, guild count, autotick status. |
| `snapshot [--json] [--pick a.b.c]` | `GET /snapshot` | Default: a compact summary (tick, the `calendar` block, guild + venture counts). `--json` dumps the whole snapshot; `--pick calendar` extracts one dotted path. |
| `starters` | `GET /starters` | Every startable system (id, ring, name, Terran homeworld). |
| `new-galaxy [--seed N] [--utc-offset H]` | `POST /admin/galaxy/new`, then `GET /snapshot` | Creates a galaxy and reads back `calendar.dayAnchorTick` to confirm it is midnight-anchored. `--utc-offset` is in **hours** (default 0 = UTC; `-12`…`+14`, halves allowed) and picks *which* midnight — frozen at creation. **Warns that this REPLACES the active galaxy.** |
| `seat-demo [--window N]` | `POST /admin/galaxy/new` *or* `POST /reset` + `POST /action`, `GET /starters`, `GET /system/:id`, `POST /action` ×5 | The two-mine 100 %-licence console demo — see below. |
| `verify-cycle [--seed N]` | `POST /admin/galaxy/new`, `GET /starters`, `GET /system/:id`, `POST /action` ×3, `GET /snapshot` | **The standard post-redeploy check** — see below. |
| `tick [n]` | `POST /tick` ×n | Manual advance (default 1), for short-window testing when the boot clock is off. |

Flags: `--base <url>`, `--seed N`, `--pick a.b.c`, `--json`, `--window N`, `--help`/`-h`.

### `verify-cycle` — the standard post-redeploy check

Run it after every redeploy (section 9) to prove the ruled commitment cycle is actually live on the
running container. It creates a fresh galaxy, auto-finds a titanium node in an unclaimed starter,
founds a guild, establishes a mine, licenses it at 100 %, reads the result back, and asserts three
things — every figure read back from the server, none computed here:

    docker exec starfare node tools/admin.js verify-cycle

      PASS  venture.syndicateCommitment === 7200       read back 7200
      PASS  calendar.windowN === 1440                  read back 1440
      PASS  calendar.dayAnchorTick present             read back -896

      ALL PASS — the 24-hour, midnight-anchored commitment cycle is live on this server.

A `120` commitment or a `24` window means the container is running code from before the `N` 24 → 1,440
flip; a missing `dayAnchorTick` means it predates the calendar layer. Either way: **the redeploy did
not take** — check `docker logs starfare` and section 10's "running container is behind the code" row.

> ⚠️ `verify-cycle` and `seat-demo` (without `--window`) both **create a galaxy**, which REPLACES the
> active one. Run them on a rig, or accept that the live world is being rebuilt. Back the state dir up
> first if it matters: `cp -a ~/starfare-state ~/starfare-state.$(date +%F)`.

### `seat-demo` — the two-mine licence demo

The generalised, committed form of the old `seat_licence_demo.sh` paste. It founds a guild, seats **two
titanium mines on one starter system**, and licenses **both at 100 %**, so the system's whole fresh
titanium pile is spoken for — the contention the Production Console's Syndicate roster renders in
pursue order. It prints where it seated and the console URL to open:

    docker exec starfare node tools/admin.js seat-demo
    # → console  https://starfare-1.online/console?guild=seat_demo&system=sys_0002

By default it seats on a **fresh, midnight-anchored galaxy** running the ruled 1,440-tick window, so a
full cycle takes a real day. For short-cycle console testing, `--window N` instead uses `POST /reset`
plus a `setWindowN` action — a **tick-0 test galaxy with no midnight anchor**, which is the only place
a short window is reachable at all (`setWindowN` is a setup-only knob, legal only at tick 0):

    docker exec starfare node tools/admin.js seat-demo --window 24
    docker exec starfare node tools/admin.js tick 24     # roll a whole short window by hand

`seat_licence_demo.sh` is superseded by `seat-demo`; nothing else in this runbook is retired.

## Deferred / not in this runbook (by design)
- **Postgres, multi-user, in-app auth** — Phase 2/3. Cloudflare Access is the interim gate; real
  per-role admin auth (so the admin panel isn't "the whole site is the operator") is Phase 3.
- **A poll-cadence config surface** — the waiting-player poll is a client literal (1 s) today; belongs
  beside `STARFARE_TICK_MS` as operator config eventually.

*Grounding: the lifecycle build landed as PRs #17/#18; client polish (HUD trim, planet art,
uptime-to-years) as #19; the manifest-row re-cut as #20. `sim/server.js` binds `0.0.0.0:$PORT`
(default 7331); durability via `STARFARE_PERSIST_DIR`; boot clock via `STARFARE_TICK_MS`. No engine
change to deploy — pure ops.*
