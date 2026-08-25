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

> **As built — amended 25-08-26 (Slice A).** The guard is implemented as specified except for what it
> falls back TO: rather than dropping to NO GALAXY, the boot **finishes the interrupted Create** — it
> discards the mismatched state, builds a fresh `createZeroState()` on the seed that is actually in the
> volume, persists it and clears the journal, logging `INCONSISTENT SAVE` to stderr. The invariant this
> section exists to protect is unchanged: the broken pairing is **never** loaded. The difference is that
> the operator's last recorded intent (this seed is the galaxy) is completed instead of thrown away, and
> the server comes back playable rather than needing a second manual Create for an act already begun.
> Detected as `state.world.seed !== getSeedNumber()`.

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

## As built — Slice A (25-08-26)

The engine/server half is landed; the admin-panel UI is Slice B. What exists now:

- `sim/seed.js` gains **`setSeed(seedObject)`** — swap the active seed, invalidate the cached index.
  With none set it falls back to the committed `data/seed.json`, so a run without a volume (and every
  test) is unchanged. The module still does no file IO of its own: the server owns that and hands it a
  seed object.
- `sim/persist.js` gains **`saveSeed` / `loadSeed` / `deleteGalaxy`**; `saveSeed` uses the same
  temp-file + rename atomicity as `saveState`. The active galaxy is the trio in the volume.
- `sim/server.js` holds the two states: **NO-GALAXY** is `liveState === null`, and every route answers
  `{state:'no-galaxy', reason}` — `/galaxy`, `/starters`, `/system/:id` as 404; `/snapshot` as a 200
  marker the client can read; `/tick`, `/action`, `/reset`, `/autotick/*` as a 409 refusal. Nothing
  throws. With a boot clock configured but no galaxy the clock is **ARMED**, not started, and starts on
  Create.
- **`POST /admin/galaxy/new {seed?}`** and **`POST /admin/galaxy/delete`**, open at the server exactly
  as `/reset` is (Cloudflare Access is the gate; real role auth stays Phase 3), namespaced under
  `/admin/` so the client can surface them only on the admin panel. Both require a volume — without one
  there is no galaxy to own and they refuse with a 409.
- **`/health`** gains `galaxy` (`'active'|'no-galaxy'`), `seed` (the active number or null),
  `uptimeSeconds` and `serverTime`, which Slice B's HUD reads.

The pure engine is untouched and the snapshot schema stays 7: this slice is seed-source and server
lifecycle wiring only.

## As built — Slice B (25-08-26)

The client half is landed; the whole lifecycle is now playable through the browser. No `sim/` change.

- **`/inspect` is the admin panel.** Above the god's-eye panels it reads `GET /health` on the same ~1 s
  cadence as `/snapshot` and shows `ACTIVE — SEED ####` / `NO GALAXY`, tick, guilds, the server's wall
  clock and `uptimeSeconds` as `DD:HH:MM:SS`. Below that: a seed field (blank randomises) with **Create
  Galaxy**, and **Delete Galaxy**. Both are behind an explicit confirm naming what is destroyed —
  **Create is offered in both states**, because creating over an active galaxy replaces it — and both
  re-read `/health` and `/snapshot` afterwards instead of assuming they worked. A non-integer seed is
  refused client-side before a request goes out. The watch loop detects the `{state:'no-galaxy'}` body
  (HTTP 200, a normal answer) *before* `validate()`, and **hides** the god's-eye panels: a deleted
  galaxy's figures must never sit on screen looking current. The page still names no `/action`,
  `/tick`, `/reset` or `/autotick` — it may create and delete a galaxy, and still cannot advance one,
  act inside one, or reset one. Its `<h1>` and the Slice-0 test that pins it still read OPERATOR WATCH;
  renaming both is a one-line change deliberately left out of a client-only slice.
- **The player portal holds no admin control** — `/admin/galaxy` appears nowhere in its bytes.
- **NO GALAXY, from the player's side** is a calm wait, not an error: the connect card reads NO GALAXY /
  "the operator hasn't opened a galaxy yet — this page will connect on its own the moment one exists",
  the button is disabled, and `/health` is re-asked until it flips. It fetches **neither `/galaxy` nor
  `/starters`** while waiting (both are 404 by design there). The live poll treats the same body the
  same way: if a galaxy is deleted under a player, the map is dropped and they return to the wait.
- **Onboarding** offers the seed's starter list **minus every system id in the snapshot's `claims[]`**,
  each labelled by its ring, and says so if none is left. Note that in today's single-guild dev rig the
  client adopts `guilds[0]`, so the form is only reached when the galaxy has no guild at all — the
  filter is therefore correct but rarely subtractive until per-player identity lands (Phase 3).
- **HUD:** `SEED ####`, `Player Guild: <name>` — or an **Establish Guild** button where the name would
  sit, which returns to the connect screen — `Server Time HH:MM`, and `Server Uptime DD:HH:MM:SS`. All
  four are read from `/health`; the tick counter still comes from the snapshot. The radial sweep beside
  the clock stays what it always was: decoration that counts nothing.

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
- ~~The **HUD server-time / uptime** readout~~ — built in Slice B, read from `/health`.
