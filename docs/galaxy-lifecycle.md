# Starfare — galaxy lifecycle & the admin panel (design ruling, 25-08-26)

> Companion to `design.md §14` (Architecture / the boot lifecycle), `docs/persistence-model.md`
> (durability), and `docs/client-wiring.md` (the client seams). This pins how a server's ONE galaxy
> is **created, persisted, and deleted at runtime**, and moves the operator's destructive controls onto
> a proper **admin panel**. On the galaxy lifecycle this doc wins; on engine behaviour the engine wins
> and this doc is the bug (§18 rule 2). It **revises** two earlier notes, called out inline:
> design.md §14's "begins ticking when the first guild is founded" and client-wiring.md §2's
> "the watcher only watches."

## The mission

A running server hosts exactly **one** galaxy, with a real runtime lifecycle the operator drives:
**create → play → delete**. The **seed becomes part of the persisted save**, so a generated galaxy
survives restarts, and "start a new game" is a button, not a redeploy. This exists so the seed
generator and the onboarding can be iterated on live.

## The persistence model change — the seed joins the save

Today the seed (galaxy geometry) is **baked into the image** (`data/seed.json`, the same galaxy every
deploy); only the live state persists in the volume. Change: the **active galaxy** =
`{ seed.json, state.json, journal.jsonl }`, all in `STARFARE_PERSIST_DIR` (the mounted volume).

- **Boot:** the volume holds a `seed.json` → restore that galaxy (seed + state + journal replay).
  The volume has **no seed** → the server is in the **NO-GALAXY** state (see below).
- `data/seed.json` stays in the repo as the generator's committed reference / test fixture and the
  generator's default; it is **not** auto-loaded as the active galaxy. Decision 1: a fresh deploy with
  an empty volume starts with **no galaxy**, not the baked default.

## The three lifecycle states

1. **NO GALAXY** — empty volume, no active seed. The server is up and reachable, but there is nothing to
   play. The **player portal** shows a "waiting — the operator has not created a galaxy yet" state (a
   player cannot create one). The **admin panel** shows a **Create Galaxy** control.
2. **ACTIVE** — a seed + live state exist and persist; the clock ticks (see below). Players onboard and
   play; the admin panel watches and can Delete.
3. (transition) **CREATE / DELETE** — the admin actions that move between the two, below.

## Create Galaxy (admin action) — atomic

`Create Galaxy { seed? }`:
1. **Stop the clock.**
2. **Generate** the seed: `tools/generate_seed.js`'s `generateGalaxySeed(seed)` (already a callable
   function). Decision 2: `seed` is **optional** — a number makes a **reproducible** galaxy
   (`mulberry32(seed)`; same number → same galaxy, so a galaxy is shareable by its number, roadmap
   Track G), and if omitted a number is **randomised**. Either way the resolved number is **recorded and
   displayed** as `SEED ####`.
3. **Write** the generated `seed.json` to the volume.
4. **Reload the seed index** so `sim/seed.js` (and the `/galaxy` buffer) serve the NEW seed. This must
   happen **before** step 5.
5. **Build a fresh zero-state on the new seed** (`createZeroState`) — which re-plants the Syndicate's
   claims (`getCitadel()` + one waystation claim per `getOutposts()` entry) on **this** galaxy's
   landmarks. The waystations/Citadel are part of the generated geometry; the zero-state re-establishes
   the Syndicate on them.
6. **Persist** (write state.json, clear journal) and **start the clock** — tick resumes at **0** and the
   galaxy turns immediately, **regardless of players or bots** (revises design.md §14's "begins ticking
   when the first guild is founded"; a persistent real-time world always turns).

**Atomicity (the failure mode this guards):** never a new seed with the OLD state — the old ventures
reference site ids that will not exist in the new galaxy. The seed swap and the zero-state are one
operation. A crash mid-create can leave the volume with a new seed but no/old state; on boot, detect
that inconsistency and fall back to **NO GALAXY** (loud, re-create required) rather than load a broken
pairing.

## Delete Galaxy (admin action)

`Delete Galaxy`: stop the clock → clear `seed.json` + `state.json` + `journal.jsonl` from the volume →
**NO GALAXY**. The admin panel then offers Create again.

## The admin panel — the operator surface (revises "the watcher only watches")

The existing operator watcher (`/inspect`, Slice 0) becomes the **admin panel**: the god's-eye state it
already renders **plus** the galaxy-lifecycle controls (Create / Delete, the seed input + the displayed
`SEED ####`). This revises `client-wiring.md §2`: the **admin panel** watches AND holds **operator**
controls; the **player client (`/`) holds no admin or destructive controls** — the principle that
mattered ("no destructive/admin controls on the player surface") is preserved, just relocated. The
admin panel is **operator-only**, enforced for now by Cloudflare Access (the whole site is the
operator); real per-role admin auth is Phase 3. Keep it unlinked from the player flow.

## Player identity & onboarding (no app auth yet)

No application login exists (Cloudflare Access gates the site; Phase 3 adds per-user auth). So the
player HUD identity is simply the **guild**: `Player Guild: <guild name>` when a guild exists, else an
**Establish Guild** entry. Onboarding is the existing found-guild flow (client-wiring Slice 1), refined:
the starter dropdown lists the **unsettled** starter-eligible systems (terran-homeworld systems not yet
claimed — filter the claimed ones out), each labelled **inner / middle / outer** ring; a guild-name
field; **Establish Guild** → enter the map.

## Tick cadence

The clock runs from create/boot regardless of players. The interval is `STARFARE_TICK_MS` (operator
config, not a game number — design.md §15.7): **production is `60000` (one tick per minute)**; the dev
default stays unset/manual. Changing it is a deploy-env change, no code.

## Runtime read sites to make reloadable (for the build)

Two runtime reads of the seed must serve the ACTIVE (volume) seed and reload on create:
`sim/seed.js` (the cached `require('../data/seed.json')` index → a reloadable read from the active path
+ an invalidate/reload function) and `sim/server.js`'s `/galaxy` buffer (`SEED_JSON`, read once at
module load → re-read on create; serve a NO-GALAXY response when there is none). Comments/tests that
mention `data/seed.json` are not runtime reads.

## Deferred (not in this ruling)

- **Multiple named save slots** — one active galaxy per server for now (Decision 3).
- **Real admin/role auth** — Phase 3; Cloudflare Access is the interim gate.
- **Seed-share-by-number UX** beyond displaying the number (the reproducibility is already there).
- The **HUD server-time / uptime** readout is presentation + a `/health` uptime field; harmless detail,
  built with the client slice.
