# Starfare — client-wiring plan (the game client becomes the game)

> Status: design ruling, 24-08-26. Companion to design.md §14 (Architecture),
> §5 (production — the client computes no game number), §15.7 (the auto-tick
> heartbeat), §4–5 (ventures & the licence), and to `docs/persistence-model.md`
> (the now-deployed durability) and `docs/venture-establishment.md` (the
> establishment popup this plan wires up). On what the client-server seam IS,
> this doc wins; on engine behaviour the engine wins and this doc is the bug
> (§18 rule 2). When it disagrees with the repo, read the repo.

This pins the section that turns the deployed dev rig into **the actual game,
played through the game client** — the whole core loop (found → explore →
establish → produce → persist) done by a *player* in the browser, with a
purpose-built watch-only operator panel behind it. It is built as a sequence of
deployable vertical slices against the SAME engine, which is not touched.

## The mission

`starfare-1.online` stops being a dev testbed and becomes the game. By the end
of this section the entire core player loop happens **through the player
client**, on the real committed seed, against the live persistent engine:

1. **Found** your guild (pick a starter system) — from the client.
2. **Explore** the real galaxy (map + drill-down) — from the client.
3. **Establish** a venture on a site — from the client.
4. **Produce** — run and tune the economy in the console — from the client.
5. **Persist** — it survives restarts (already deployed, `persistence-model.md`).

## Governing principles (the rules the build holds to)

1. **The game client is the only way to ACT.** Founding, establishing, tuning —
   every mutation a player makes goes through the player UI. Nothing builds
   through a dev panel.
2. **The watcher only watches.** A new operator panel at **`/inspect`** reads the
   full state on a poll and renders it; it has **no action controls of any
   kind**. It cannot mutate the galaxy.
3. **The testbed dies.** `client/testbed.html` is **deleted** (in Slice 1, once
   the client can seed a game — see the walk). Its watch role is replaced by
   `/inspect`, done for purpose; its action controls are not replaced anywhere —
   they move into the game client as real player surfaces.
4. **Two doors only:** `/` = the player client, `/inspect` = the watcher. No
   `/testbed`.
5. **The clock runs itself.** The auto-tick heartbeat (§15.7) **starts on server
   boot**, configured by an operator env var (e.g. `STARFARE_TICK_MS`), so the
   persistent world always turns and `/inspect` stays honestly read-only. This is
   operator config, not a game/tuning number (consistent with §15.7's ruling that
   the interval is *playback speed*, not tick-duration) — it does NOT go to
   `phase-1-tuning.md`. A player cannot pause a persistent world; neither, in
   normal running, does the operator.
6. **Demos are deleted, not bypassed.** The client only ever loads the real seed
   via a new **`GET /galaxy`** endpoint (which serves the already-committed
   `data/seed.json` — the same seed `sim/seed.js` reads, so map and detail can
   never disagree on geometry). The client's `buildDemoGalaxy()` and its baked
   HUD/identity literals are removed. Loading the real 1500-system seed into the
   real renderer IS the seed generator's first full-scale test.
7. **Player-safe vs god's-eye is a real split — two projections.** `/snapshot` is
   a **god's-eye lens** (`sim/snapshot.js` header: "a debug lens, NOT player UI")
   — it ships every guild's exact stockpiles and the true `galacticSupply`, which
   a player must never see. This section defines a **player projection**: the
   client reads only player-safe fields (exactly as `client/console.html` already
   does), and the god's-eye view is the **operator-only** `/inspect`. The
   inspector is the first concrete instance of the **operator/engine read plane**
   that the Storyteller (targeting who has "grown too comfortable") and the
   Syndicate pricing engine (keying off true supply) will later consume. Real
   **server-side per-viewer filtering** — the server emitting a scoped snapshot
   per requester — is DEFERRED (Phase 2/3); for now the split is enforced by
   client discipline behind Cloudflare Access, and that deferral is recorded, not
   faked.
8. **Wire, don't rebuild.** The engine already has the actions this section needs
   — `foundGuild`, `establishVenture`, `setProductionProfile` are real, validated,
   tested (`sim/actions.js`), and `client/console.html` is already written for
   HTTP behind its mock (`apiLive`). This section connects existing plumbing to a
   real front end. The pure engine, the tick, and the snapshot schema are NOT
   changed; the client computes **no game number** (§5) — it renders
   engine-resolved values and POSTs actions.
9. **Verify by playing, not by watching numbers.** A slice is done when you can
   **do the thing through the game UI** and `/inspect` confirms the state changed
   correctly underneath — not when a value moves in a grid. Mechanical tripwires
   still guard the seams (served-route markers, action round-trips), but the
   acceptance test is a human playing the loop.

## Repo grounding (what is already true — verified 24-08-26 @ `7ac5523`)

- **Engine actions exist and are tested:** `foundGuild`, `establishVenture`
  (mining/refining), `setProductionProfile`, plus the dev-scaffold
  `setSyndicateCommitment`/`setWindowN` (`sim/actions.js`). `POST /action`
  validates then applies without ticking; returns `{accepted, reason, snapshot}`.
- **The seed is committed:** `data/seed.json` (~5.8 MB) is git-tracked and rides
  in the container — full geometry (system coords/ring/name, planets, resource
  nodes, settlement slots, outposts, Citadel). The generator
  (`tools/generate_seed.js`, tested) is mature; no structural seed work is needed
  for this section.
- **The console is pre-wired:** `client/console.html` has a live `apiLive(method,
  path, body)` fetch path shadowed behind a mock router that already names the
  real routes, POSTs `setProductionProfile` from every control, reads only the
  player-safe snapshot subset, and polls `/snapshot` on a ~1 s cadence (defaults
  live). Un-mocking is renaming `apiLive`→`api` / deleting the mock.
- **No endpoint serves the whole galaxy.** `/starters` and `/system/:id` return
  ids/archetype/resourceType but **no coordinates**; there is no "full galaxy"
  endpoint. `GET /galaxy` is the one genuinely new read surface this section adds.
- **The full client is three seams** (`docs/mockups/starfare-client-full.html`):
  the galaxy map is fully data-driven (swap `buildDemoGalaxy()` → fetched seed
  into `window.__loadGalaxy`); HUD/identity is hardcoded literals; the console is
  an iframe from a base64 blob — repoint it at the served `/console` route rather
  than editing the blob, so it tracks the maintained console.

## The player projection (which snapshot fields the client MAY read)

The player client reads, for the **player's own guild only**: `tick`; the guild's
`name`, `credits`; its `stockpilesBySystem`; its `production[]` entry (the
resolved per-system per-good report — forks, reserve, commitment window — as the
console already renders); its `ventures[]` (and `occupancy`) for its own sites;
and `claims[]` for **territory control** (who owns which system — visible to all
in-world). It must **NOT** render `galacticSupply` totals, the `syndicate.ledger`,
or any other guild's `stockpiles`/`stockpilesBySystem`/`production`. Occupancy of
*other* guilds' sites (a site is taken) is visible; their economic internals are
not. This list is the working contract; it may be refined as panels are wired
(refinements are doc-and-code in the same commit).

## The walk (five deployable slices — each ends in something real)

- **Slice 0 — plumbing + the watcher.** Add `GET /galaxy` (serves the committed
  seed); serve the player client (route TBD-live in Slice 1) and the operator
  `/inspect` watch-only panel (a live ~1 s poll of `/snapshot`, full god's-eye
  render, zero controls); make the clock auto-start on boot via `STARFARE_TICK_MS`.
  Deliverable: deploy and watch the real persistent galaxy's full state live; the
  seed is served. No client rewrite yet; testbed still present as the only seeding
  path until Slice 1.
- **Slice 1 — found your guild, through the game.** The connect/uplink screen
  becomes a real first-run flow: fresh galaxy → pick a starter (`GET /starters`) →
  `foundGuild` from the client. Galaxy map + HUD go live on the real seed;
  `buildDemoGalaxy()` and the identity literals are **deleted**; the front door
  `/` becomes the player client; **`client/testbed.html` is deleted here** (the
  client can now seed a game). The seed generator's first full-scale test.
- **Slice 2 — explore for real.** Galaxy → system → planet drill-down: seed
  geometry (`/system/:id`) overlaid with live `occupancy` (compose-by-id, the
  pattern the retired testbed proved). Navigate to a vacant site.
- **Slice 3 — establish a venture, through the game.** The establishment popup
  (`docs/venture-establishment.md`, `docs/mockups/venture-establishment.html`)
  wired to POST `establishVenture` on the clicked site. Licence terms shown but
  **mock** over a real venture (the venture is created for real; fee/equity are
  cosmetic until the licence layer lands — exactly as the establishment brief
  specifies).
- **Slice 4 — run the economy, through the game.** Console un-mocked (iframe →
  the served `/console`): profiles, priorities, throttles on the live, persistent
  galaxy. Preserve the one cross-frame message (`{source:'starfare-console',
  kind:'venture', …}` → the industrial hero art).

Each slice is a separate Claude Code prompt, on its own branch + PR, doc-and-code
in the same commit, verified by playing the loop and confirming against `/inspect`.

## Out of scope for this section (later, reached by playing this one)

Real licence economics (fees/equity/breach) — the establishment popup shows mock
terms over a real `establishVenture`. Multi-user or auth beyond Cloudflare Access.
Bots, the market/trading, transport/tolls, the Storyteller and narrative layer.
Real server-side per-viewer snapshot projection (Phase 2/3). None of these are
touched here.

## Deferred to the decision checklist (not invented here)

- The **player projection's** exact final field set (working contract above; may
  refine per panel).
- **Server-side per-viewer snapshot filtering** — the real fix for the god's-eye
  split; Phase 2/3.
- `STARFARE_TICK_MS` is **operator config, not a game number** — no ruling needed;
  it does not go to `phase-1-tuning.md`.
