# Starfare — deployment runbook (game container behind starfare-1.online)

> **Updated 2026-08-25.** The container runs the **galaxy-lifecycle** build (create/delete a galaxy at
> runtime from the admin panel; the seed lives in the volume; a boot clock ticks the world once a
> minute). Host facts, learned in the field: the repo clone is `~/starfare` and state lives at
> `~/starfare-state` on the Docker host (`docker@docker`) — substitute your host's actual paths; and
> **the tunnel connector needs `--protocol http2`** (this network drops QUIC after the handshake). The
> run command carries **`-e STARFARE_TICK_MS=60000`** (one tick/minute), and every redeploy ends with
> **`docker image prune -af`** — see **Disk hygiene** (section 11), which a full disk made non-optional.

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
2. Type a seed number (or leave blank to randomise) → **Create Galaxy** → confirm. The strip flips to
   **ACTIVE — SEED ####**, tick climbing once a minute; the 10 Syndicate claims re-plant on that seed.
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

## Deferred / not in this runbook (by design)
- **Postgres, multi-user, in-app auth** — Phase 2/3. Cloudflare Access is the interim gate; real
  per-role admin auth (so the admin panel isn't "the whole site is the operator") is Phase 3.
- **A poll-cadence config surface** — the waiting-player poll is a client literal (1 s) today; belongs
  beside `STARFARE_TICK_MS` as operator config eventually.

*Grounding: the lifecycle build landed as PRs #17/#18; client polish (HUD trim, planet art,
uptime-to-years) as #19; the manifest-row re-cut as #20. `sim/server.js` binds `0.0.0.0:$PORT`
(default 7331); durability via `STARFARE_PERSIST_DIR`; boot clock via `STARFARE_TICK_MS`. No engine
change to deploy — pure ops.*
