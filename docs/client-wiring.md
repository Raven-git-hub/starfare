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

> **Console + manifest polish — 25-08-26 (three fixes on top of the console rebuild).**
> (1) The Syndicate **top-up limit** field was ~46px with its digits right-aligned under
> the stepper arrows, so the number was invisible: it is now ~94px, left-aligned, with
> the right padding keeping the arrows clear. Visual only — `SYN.limit` is unchanged.
> (2) The **planet-manifest rows** are reformatted: the left is the site TYPE (the
> resource a node yields, or "Settlement"), the sub-line is the site id (what you check
> against `/inspect`), and the right is the occupancy — `VACANT`, or the venture id and
> the guild that owns it (`rev_pl_00004_n03 · Reviewers`), replacing YOUR MINE /
> OCCUPIED. **Colour: green when the venture is the player's own guild's, yellow when it
> is another guild's**, vacant neutral. To render a rival's row the client now also
> keeps that occupant's `ventureId` in `LIVE.siteInfo` — a venture id plus its owner is
> occupancy-level identity (who holds the site, visible in-world, and already in the
> snapshot's `occupancy` map), NOT an economic internal, so §7 still holds: no rival
> rate, resource or recipe is read.
> **State-model note:** ownership is already in the snapshot (`ownerGuildId` per
> venture), so the own/other split is fully derivable today — no new live-state field is
> needed. What yellow currently means is simply "another guild's venture". The richer
> distinction it anticipates — a **leased** site where the land owner and the venture
> owner differ — belongs to the Leasing layer (`venture-establishment.md` §4/§5), still
> deferred; this colour rule is the simple own/other split until leasing refines it.
> (3) The **Syndicate tab** no longer shows a fabricated licence set. Its roster is built
> from `producersOf(report, good)` — the selected good's REAL producing ventures in this
> system, the same list the Production column renders — each with the engine's own
> `syndicateCommitment`, and its thermometer measures the good's real window (`delivered`
> against `Q`). With no licence layer every commitment is 0 and no window is emitted, so
> the honest render is an empty thermometer reading *"no commitment yet"* and rows reading
> *"no commitment"* — never a fabricated fill. The seven phantom titanium mines that
> appeared on every good's page are deleted, along with the invented per-licence fees and
> the order presets that had nothing to order by; the advisory top-up control remains,
> tagged mock, POSTing nothing.

> **Console rebuilt to the authoritative design — 25-08-26 (follow-up to Slice 4).**
> Slice 4 pointed the client's iframe at the live `/console`, but `client/console.html`
> had been built to a *superseded* mockup, so the deployed System Manifest showed the
> old plain console. It is now rebuilt to `docs/mockups/console_restructure.html` (its
> appended restructure block): the 3-zone frame `[celestial | console | industrial]`
> and the 7:15:10 flow — Production │ Distribution │ Consumption/Syndicate — with the
> trend cards on the venture stacks, the two top-up squares in the stockpile row, the
> Gate-1 arm panels and the Syndicate thermometer. It is a RE-SKIN, not a new data
> path: `api`/`refresh`/`sendAction`/`sendProfile`, the ~1 s poll, the `?embed=1&guild=&system=`
> focus, the operator-drive gating and the venture→hero `postMessage` are all kept, and
> the design file's mock backend was not carried across. **Three deliberate deviations
> from the mockup:** the **throttle** lives on the consumer chip in the central column
> (the mockup puts it in the industrial hero, which embed mode drops — the embedded
> console *is* the System Manifest, so it must keep its throttle); the trend sparklines
> are **never seeded** with invented history (empty until two real ticks are observed);
> and the licence **roster** and the hero's **facility** block carry visible **MOCK**
> tags, since the engine has no licence layer, droids or assets — only the thermometer's
> delivered / send-rate / ticks-remaining are real window telemetry. `embed=1` is now
> the only thing that means "inside the client"; `guild`/`system` are focus alone, so a
> standalone `/console?guild=&system=` still gets the full three-zone frame.
> Engine, tick and snapshot untouched; schema still 7; no `sim/` source change.

> **Section COMPLETE — 25-08-26.** All five steps run through the player client at
> `/` on the live, persistent galaxy, with the operator watching from `/inspect`.
> Slices 0–4 all landed; what stays deliberately unbuilt is listed under *Out of
> scope* and *Deferred* below — chiefly the licence economy (the establishment
> panel's fee/equity/asset controls remain mock), per-viewer snapshot filtering,
> and real player identity.

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
   **Revised 24-08-26 (Slice 2) — `POST /reset` comes back RUNNING.** "Always
   turns" has to survive a reset too: Slice 0 left a deployed galaxy frozen after a
   reset until someone restarted the server. Reset now still stops-then-zeroes
   (nothing fires mid-wipe) and then **re-arms the boot clock** if one was
   configured. This supersedes §15.7's ruling (3) *for a booted deployment only*:
   with `STARFARE_TICK_MS` unset there is no clock to put back, so the manual dev-rig
   flow (reset → deploy at tick 0 → start by hand) is untouched.
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
- **The full client is three seams** (`docs/mockups/starfare-client-full.html` — **moved to `client/game.html` in Slice 1**):
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

- **Slice 0 — plumbing + the watcher. LANDED 24-08-26.** Add `GET /galaxy` (serves the committed
  seed); serve the player client (route TBD-live in Slice 1) and the operator
  `/inspect` watch-only panel (a live ~1 s poll of `/snapshot`, full god's-eye
  render, zero controls); make the clock auto-start on boot via `STARFARE_TICK_MS`.
  Deliverable: deploy and watch the real persistent galaxy's full state live; the
  seed is served. No client rewrite yet; testbed still present as the only seeding
  path until Slice 1.
  *As built:* `GET /galaxy` serves `data/seed.json` verbatim from a buffer read once
  at boot (unreshaped, unfiltered — public identity data, not god's-eye);
  `GET /inspect` serves the new `client/inspect.html`, which renders the whole
  schema-7 snapshot and fails LOUD (visible error, last good render kept) on a
  network error, a non-JSON body, or a schema that is not the one it was written
  against; `STARFARE_TICK_MS` starts the EXISTING heartbeat in the CLI boot block
  (unset ⇒ off, byte-for-byte the old behaviour; an unusable value exits non-zero
  before the port is bound). The engine, the tick and the snapshot are unmodified.
  `client/state_inspector.html` is untouched — it stays the offline file-load debug
  tool; `/inspect` is its served, live sibling.
- **Slice 1 — found your guild, through the game. LANDED 24-08-26.** The connect/uplink screen
  becomes a real first-run flow: fresh galaxy → pick a starter (`GET /starters`) →
  `foundGuild` from the client. Galaxy map + HUD go live on the real seed;
  `buildDemoGalaxy()` and the identity literals are **deleted**; the front door
  `/` becomes the player client; **`client/testbed.html` is deleted here** (the
  client can now seed a game). The seed generator's first full-scale test.
  *As built:* the mockup is now `client/game.html`, served at `/`, with a
  traversal-safe `GET /assets/<path>` route for its art. The connect screen reads
  `/snapshot` on entry and either **adopts** the galaxy's existing guild (single-guild
  dev rig) or shows the found form; founding POSTs `foundGuild` with a name-slug id
  (suffixed if taken) and **2,000** starting credits (`[FIRST-CUT]`,
  `phase-1-tuning.md`). Territory comes from `claims[]` (`landmarkKind === 'system'`),
  the player's own systems in the reserved accent and rivals by a stable per-id hue;
  the HUD's guild/credits/tick come from the poll, and the radial clock is kept as
  pure decoration that counts nothing. The **ring vocabulary needed no renderer fix**:
  `ring` never drove colour or size in this renderer — it is display-only, so the
  seed's `inner`/`middle`/`outer` all render (verified against a `middle` system).
  The detail screen's demo "VACANT" labels — an invented *live* claim — were
  neutralised to a *live data next* placeholder, and the still-mocked console iframe
  now carries a visible MOCK tag, so nothing on screen reads as live that isn't.
- **Slice 2 — explore for real. LANDED 24-08-26.** Galaxy → system → planet drill-down: seed
  geometry (`/system/:id`) overlaid with live `occupancy` (compose-by-id, the
  pattern the retired testbed proved). Navigate to a vacant site.
  *As built:* no `/system/:id` round-trip was needed — the full geometry is already
  in memory from `GET /galaxy`, so the drill-down reads it there. `adaptSeedSystem()`
  now preserves each resource node's and settlement slot's **`id`** — the join key —
  and every manifest row renders that site's live state: **VACANT** (the engine says
  no venture sits there), **YOUR MINE / YOUR REFINERY** with the venture id and what
  it runs, or **OCCUPIED · &lt;guild&gt;** for another guild's site and nothing more.
  The snapshot poll now also carries `occupancy` verbatim and a **player-safe** venture
  read: own ventures keep `{id, siteId, type, resourceType, recipeId}`; other guilds'
  contribute only owner identity — no rate, resource, recipe or any economic internal
  (§7). The recipe catalog (`GET /recipes`, static rules) is fetched once so a refinery
  reads as what it produces. An open manifest re-renders only when occupancy actually
  moves, so a site seated under the player updates without the list churning.
  A vacant site is reported, **not** made actionable — establishing is Slice 3.
- **Slice 3 — establish a venture, through the game. LANDED 24-08-26.** The establishment popup
  (`docs/venture-establishment.md`, `docs/mockups/venture-establishment.html`)
  wired to POST `establishVenture` on the clicked site. Licence terms shown but
  **mock** over a real venture (the venture is created for real; fee/equity are
  cosmetic until the licence layer lands — exactly as the establishment brief
  specifies).
  *As built:* the popup opens from a **vacant** row in the Slice-2 manifest (occupied
  rows keep their readout) and is re-skinned onto the detail screen's existing tokens
  and fonts rather than importing the mockup's duplicate stack. The payload is exactly
  what `sim/actions.js` accepts and nothing more — `{type, guildId, ventureId, siteId,
  ventureType, resourceType|recipeId, productionRate}`; no `assetId`, fee, commitment,
  equity or renegotiation window is sent, and `syndicateCommitment` stays 0. The recipe
  picker is the **live** `GET /recipes` catalog (Tier 3/4 present but disabled per §4).
  Every economic control carries a visible **MOCK · no engine** tag and a note that
  none of it is stored, so a player is never misled; the success screen names what was
  actually recorded beside what was merely shown. `productionRate` is a uniform **5**
  (`[FIRST-CUT]`, `phase-1-tuning.md`). Establishment is deliberately **ungated** — the
  popup shows whose territory a site sits in and lets you deploy there anyway, because
  leasing (§4) is where territory becomes an economic lever.
- **Slice 4 — run the economy, through the game. LANDED 25-08-26 — the section is COMPLETE.** Console un-mocked (iframe →
  the served `/console`): profiles, priorities, throttles on the live, persistent
  galaxy. Preserve the one cross-frame message (`{source:'starfare-console',
  kind:'venture', …}` → the industrial hero art).
  *As built:* `mountConsole` points the iframe at
  `/console?guild=<id>&system=<id>` — same origin, so the console reads `/snapshot`
  and POSTs `setProductionProfile` against THIS galaxy — and re-points whenever the
  focused system changes. The embedded mock blob is **deleted**: the base64 string,
  the `atob` decode, `URL.createObjectURL` and `window.__consoleBlobUrl`, ~193 KB out
  of `client/game.html`, and the Slice-1 MOCK tag with them. The console reads the
  query string on boot and **pins** that system — even one it has no ventures in,
  where it renders the honest idle state rather than quietly showing a different
  system; with no params it self-selects exactly as before. The venture → hero
  message is emitted from the console: on render for the focused system's first
  producer (so the art is never blank or stale), and on a click of any venture row,
  which a poll never overrides. The parent's listener and `__VENTURE_ART` are
  untouched. **One judgement call:** embedded, the console hides its two OPERATOR
  drives — TICK and RESET. Neither is a player move and a persistent world is not a
  player's to step or erase (§1); standalone `/console` keeps them for the operator.

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

## Revision — the admin panel (25-08-26, see `docs/galaxy-lifecycle.md`)

Principle #2 above ("the watcher only watches") is revised: the `/inspect` operator watcher becomes the **admin panel** — it keeps the god's-eye read AND gains the galaxy-lifecycle **operator** controls (Create / Delete Galaxy). What still holds: the **player client (`/`) carries no admin/destructive controls**; operator controls live on the admin panel, operator-only (Cloudflare Access for now). See `docs/galaxy-lifecycle.md`.
