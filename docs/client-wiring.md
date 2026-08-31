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
> **The row FORMAT in this paragraph is superseded** — see *Revision — the planet-manifest
> row: type left, activity + guild right* at the foot of this doc. The site id and the
> venture id both left the row; the colour rule below survives unchanged.
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
> *"no commitment"* — never a fabricated fill. **Superseded 27-08-26:** the licence layer
> landed, the console rewire made these rows per-venture, and the licence panel slice at
> the foot of this doc made a licence reachable from the game — so a venture the player
> licenses now fills this thermometer for real, and *"no commitment yet"* is what an
> unlicensed producer reads rather than what everything reads. The seven phantom titanium mines that
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
> **Superseded in part, 27-08-26** — see *Revision — the player's licence panel goes
> live* at the foot of this doc: the panel's commitment, equity and window controls
> are now wired to `establishVenture` + `applyForLicence`, and only the ASSET picker
> (plus the breach fee and reputation readouts) is still mock. The fee is real and
> locked, but not yet charged (3b-iii).

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
in-world). It also reads the **public Syndicate figures**, which are the same for
everyone and secret from no one: `prices` / `priceBase` / `priceHistory`, and
`feeQuote` (the per-good basic licence fee in credits — see the revision at the
end of this file). It must **NOT** render `galacticSupply` totals, the `syndicate.ledger`,
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

  **Revision — the bridge carries the system inventory too (28-08-26).** The right
  zone had exactly one thing it could show: whatever venture was last posted. With
  no venture selected the embedded console had nothing to say, so the panel it
  renders in that state standalone (the system inventory) was invisible in the game.
  It now rides the SAME bridge, as a second message keyed by `kind` — `venture` when
  a chip is selected, `inventory` when none is. The payload is the console's own row
  data (`inventoryRows()` — one computation, two consumers: the standalone panel and
  this send), posted on every poll while resting, so the game's quantities are as
  live as the console's and the row order is literally the same held order. The game
  shell groups by `tier` and paints `frac` as a bar; it derives nothing (§5), the
  same rule the nameplate has always followed. In that mode it also fades its venture
  art and hides "Open venture management", which have no meaning over an inventory.
  Client-only: `client/console.html` + `client/game.html`; no endpoint, no engine,
  schema unchanged. See `production-console-model.md` for the message shape.

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

## Revision — the player HUD trim + planet-tab art (25-08-26, cosmetic)

Three client-only cosmetic fixes, no `sim/` change, schema still 7.

**1. The planet-tab backgrounds were a CROP-AND-SCRIM bug, not a nomenclature one.**
Worth recording, because the obvious suspicion was wrong: the archetype→texture wiring
is and was correct end to end — the nine `/system` archetype strings (`rocky, oceanic,
ice, desert, terran, gasGiant, molten, irradiated, crystalline`), the nine `.tex-<archetype>`
rules, the nine `assets/planets/*.jpg` files and `row.className = 'list-row tab tex-' +
p.archetype` all match exactly, and every texture loaded. What failed was purely visual:
the art is TALL PORTRAIT with the planet at the bottom, and `.list-row.tab` cropped it
`background-position:center` — so a short wide row showed the image's empty vertical
middle — under a scrim that reached `rgba(11,13,18,0.86)` at the bottom. Only the three
brightest archetypes survived it. Fixed on the planet tabs only (`.list-row.tab:not(.tex-node)`)
by cropping to `center bottom` — the planet limb IS the subject — and lightening the
scrim to `0 → 0.15 → 0.72`. The `.tex-node` chip is a flat gradient with nothing to
reveal and keeps its original crop and scrim.

**2. The player HUD deliberately carries no tick and no home-system label.** Both were
removed from `/` (element and setter). The **tick is an operator detail and stays on
`/inspect`**, which shows it in both the admin cell and the meta line; `snap.tick` itself
is untouched and still drives everything that reads it. The home-system label went
because `My System` already navigates there. The bar keeps `SEED`, `Player Guild`,
`Credits`, `My System`, `Music`, `Server Time`, `Server Uptime`.

**3. `Server Uptime` still MEANS server process uptime** — read from `/health.uptimeSeconds`,
so it resets on every redeploy and is server health, not galaxy age. That meaning is a
decision, not an oversight, and the client computes no galaxy age. Only the FORMAT changed:
`DD:HH:MM:SS` let the day field grow without bound, so days now carry up into years —
`1y 023d 04:17:09`, the year dropped when there is none (`023d 04:17:09`). `/inspect` got
the identical formatter in the same commit so the two surfaces read the same.

## Revision — the planet-manifest row: type left, activity + guild right (25-08-26, cosmetic)

Client-only, no `sim/` change, server and snapshot untouched, schema still 7. Every word
the row prints was already in `LIVE.siteInfo` — **no new live-state field**, and the
client still computes no game number.

**The row is re-cut.** The left is the site TYPE alone — the resource a node yields
(`Titanium`) or `Settlement`. The **site id is gone from the row**: it is an operator
detail and stays on `/inspect`, where you cross-check it. The right is now **two stacked
lines, right-aligned**: what is happening on the site, over the guild that owns it.

| site state | top line | bottom line | colour |
|---|---|---|---|
| vacant | `VACANT` | *(none)* | neutral |
| own mine (`kind:'mine'`) | `MINING` | the player's guild name | green `#8DBB78` |
| own settlement/refinery (`kind:'refinery'`) | the **real product** — `siteInfo.output`, uppercased (`TITANIUM ALLOY`) | the player's guild name | green |
| own other venture (`kind:'venture'`) | `PRODUCTION` | the player's guild name | green |
| a rival's (`kind:'other'`) | `IN USE` | `ownerName` | yellow/brass |

The green/yellow/neutral rule is unchanged from the 25-08-26 polish note above: green =
your own guild's venture, yellow = another guild's, vacant neutral.

**State-model note — where each line comes from, and what §7 withholds.** An **own**
site's activity is the venture's own `type`, and a refinery's product is the `output`
already resolved into `siteInfo` from `GAME.recipeOut[recipeId]` (the static `/recipes`
catalogue). Nothing is fabricated: a refinery whose recipe does not resolve to a good
reads `REFINING` — what the venture *is* — rather than naming a good the client does not
have, and Tier 3/4 ventures (`kind:'venture'`, not reachable in the engine today) read a
generic `PRODUCTION` because **no output field exists for them yet**.

A **rival's** top line is deliberately the neutral `IN USE`. §7 (the player projection)
withholds another guild's recipe, rate, resource and product, so the row says only that
the site is worked and by whom — never what it makes. This also **narrows** what the
previous format showed: the rival's `ventureId` no longer appears anywhere on the row.
It remains occupancy-level identity that §7 permits, but the row no longer has a place
for it, so the client simply does not print it.

**Deferred, not decided:** whether a **land owner** may see a **tenant's** output on a
leased site. That belongs to the Leasing layer (`venture-establishment.md` §4/§5, still
deferred). Until it rules, a non-own site's top line stays neutral for everyone.

**Two judgement calls made in the build, worth a look:**
1. *All three badges are right-aligned*, VACANT included, so the occupancy column reads
   straight down the row's right edge. Right-aligning only the occupied ones left VACANT
   hanging in the middle of the row.
2. *The guild line is 9px*, not the 10.5px `node-type` scale. The badge's own line is
   9.5px, so 10.5px would have made the guild name **larger** than the activity above it
   and inverted the hierarchy. It is dimmed (`opacity:.72`) and ellipsed on overflow.

**Size:** the tab did not grow — a node row goes **31px → 28px** (it loses a line on the
left and gains one on the right, and lands on the existing `min-height:28px` floor).
Base font sizes are unchanged: name 13.5px, badge 9.5px. One real bug surfaced and was
fixed on the way: `.tex-node`'s two cells were `40% + 66.667%`, which overflowed the row
— invisible while the badge text hugged the left, but it **clipped `VACANT` to `VACAN`**
the moment the text moved right. The badge is now `flex:1 1 auto; min-width:0`.

## Revision — the console's three distribution sliders drag properly (25-08-26, bug fix)

Client-only, one file (`client/console.html`). No `sim/` change: engine, server and
snapshot untouched, schema still 7. The `setProductionProfile` action and each slider's
**value math are unchanged** — this was drag *mechanics*, not arithmetic, and §5 still
holds: the console computes no game number.

**The bug.** The three distribution sliders — Production (`.pr-track` → `downstreamPct`),
Stockpile (`.sk-track` → `reserveLevel`) and Syndicate (`.sy-track` → the `syndicate`
send) — could not be dragged to a partial value. Every drag pinned to the maximum
(100% / all): dragging the Production fork 90% → 30% POSTed `90, 84, 100, 100, 100, …`
and stored 100.

**The root cause is a re-render detaching the dragged element.** Each `mousemove` called
`sendProfile` → `sendAction`, and `sendAction` re-renders on the POST response
(`if (r.data.snapshot) render(r.data.snapshot)`). The re-render rebuilds the stage's DOM,
so the track element the drag was holding in its `dragging` variable was **detached** from
the document. A detached node's `getBoundingClientRect()` is all zeros, so the fraction
`f = (e.clientX - r.left) / r.width` was `clientX / 0` = `Infinity`, clamped to `1` — the
maximum, every time. The ~1 s LIVE poll re-renders too and compounded it, but the
per-POST re-render alone was enough: it was broken with **View: PAUSED** as well.

**The fix — three parts, one shared `trackDrag(selector, paint, commit, snap)` helper
used by all three tracks.**

1. **Capture the geometry at `mousedown`.** The track's `getBoundingClientRect()` (and the
   `data-out` / `data-fresh` it needs) is read once, at `mousedown`, and every subsequent
   fraction is computed from that captured rect — never re-read from a node that may since
   have been rebuilt. A captured `width <= 0` starts no drag, so nothing ever divides by zero.
2. **No POST during the drag; commit once on `mouseup`.** `mousemove` only *paints* — it
   moves the fill, the handle and the panel's own readouts to the dragged position — and
   sends nothing. The one `setProductionProfile` POST fires on release. This removes both
   the per-pixel POST storm (13 POSTs for one drag → **1**) and the per-POST re-render that
   was orphaning the element. A plain click on a track still sets the clicked position: it
   commits on the `mouseup` that ends the click.
3. **Suspend re-render while dragging.** A module-level `isDragging` flag is set on
   `mousedown` and cleared on `mouseup`; `livePoll` returns early while it is set, so LIVE
   never rebuilds the DOM under a slider in hand. After release, the commit's own response
   re-renders normally and the next poll carries on. Because a stuck flag would freeze LIVE,
   a `mousemove` that arrives with no button held (a `mouseup` released outside the window
   and never seen) **abandons** the drag — clearing the flag, and deliberately committing
   nothing rather than POSTing a position the player did not release on.

**What did not change.** Each track's value map is exactly as before — `downstreamPct =
round(f × 100)`, `reserveLevel = round(f × out)`, syndicate `= { mode:'absolute', value:
round(f × fresh) }`. The two snap-clicks keep their behaviour (the amber `.sy-req` marker
→ the required rate, ceil'd; the REQUIRED box → 100%) and now run through `trackDrag`'s
`snap` hook so they still pre-empt a drag on the same `mousedown`. The native controls
(priority `select`, the reserve/downstream/throttle number inputs, syndicate mode) are
untouched — they already commit on `change`. The embed contract is unchanged; the sliders
live in the central column, which embed mode keeps, and the fix was verified there too.

**One display detail, deliberate.** During a Production drag only the **%** label follows
the cursor. The units label under it is `required × pct`, and `required` is a snapshot
figure the track element does not carry — rather than fabricate or re-derive it mid-drag,
it simply redraws on release with the rest of the panel.

## Revision — the Syndicate roster goes per-venture, and gains the pursue ranking (27-08-26)

Client-only, one file (`client/console.html`) plus four served-page assertions in
`sim/tests/server.test.js`. **No engine, resolver or snapshot change; schema still 7.**
The panel now reads data the engine has been emitting since the licence-distribution
slice and was not yet looking at, and writes the one control that slice added. §5's
display rule holds throughout: the browser renders engine truth and **computes no game
number** — every target, every delivered figure and every verdict on these rows arrives
in the snapshot; the reorder only re-sequences venture ids.

**What was wrong with the panel.** The roster drew the GOOD's window status on *every*
row — `synRoster` passed the single `R.windowStatus` into each `licRow` — so two mines
with different fates showed the same dot, and each row showed only its stored commitment
with no delivery against it. That was honest when the engine tracked delivery per good.
It stopped being honest the moment met/breach became **per licence** (§5, RULING
27-08-26): the panel was showing a rollup where the player needed the individual.

**1. Per-row verdict and delivery, from `window.perVenture`.** `synResolve` reads the
good's `perVenture` block and attaches each venture's own `{ commitment, delivered,
status }` to its roster row, matched by ventureId. `licRow` renders that row's dot and
its `delivered / commitment` — where `commitment` is the engine's `qᵢ`, the venture's
target for **this** window, so a mine licensed mid-window shows the pro-rated figure it
is actually judged against rather than its full-window commitment. `R.windowStatus` is
kept, but now only for the thermometer's overview: it is a rollup of these rows and no
longer the truth about any one of them.

A licensed row with **no** `perVenture` entry keeps the neutral mark rather than
borrowing the good's status — it means the engine is filling no window for that venture
(the accrual sums over mines, so a committed refinery has no entry). Nothing was judged,
which is not the same as having failed.

**2. The pursue ranking — display order plus the reorder control.** The committed rows
are drawn in the good's stored `pursue` order, reconciled for display by
`reconcilePursueIds`, which mirrors the engine's `reconcilePursue` rule for rule: drop a
ranked id that is no longer a committed producer, honour a duplicate once, append every
committed producer the ranking omits in establishment order. An absent ranking is plain
establishment order. Uncommitted producers stay below the block, unranked and unrankable
— there is no licence to prioritise.

Each committed row carries its rank and two movers (`▲` / `▼`), disabled at the ends
rather than hidden so the row never re-flows as a licence travels. One move POSTs the
**whole new order** through the existing `sendProfile` → `sendAction` path, exactly as
the Gate-1 fork rank already POSTs its whole permutation:

```
{"type":"setProductionProfile","guildId":"g1","systemId":"sys_0002",
 "goods":{"titanium":{"pursue":["mine-beta","mine-alpha"]}}}
```

The order moved is the **reconciled** one on screen, not the raw stored list, so a first
move on a never-ranked good stores establishment order with that one swap applied —
which is what the player just did. A **clear ranking** button POSTs `pursue: null` (the
engine's tri-state clear) and is offered only when a ranking is actually stored.

**3. The poll-clobber guard.** `livePoll` re-renders every ~1 s, and a re-render between
`mousedown` and `click` detaches the button so the click lands on nothing — the same
failure `trackDrag` fixes for the sliders, in its click-driven form. A `pollHold`
**counter** (not a flag: the two holds overlap) holds the poll from the mousedown until
the move's own response has re-rendered; `sendProfile` now returns its promise so the
release can wait for it. The mouseup release fires on **any** mouseup, not only one over
the button, so a press dragged off the control still releases instead of freezing LIVE.
Verified in Chromium with LIVE on and 1.1 s between clicks: **3 of 3 moves landed.**

**4. Layout — the numbers moved under the id.** The rank and movers cost ~30 px of a
152 px row, which truncated `mine-alpha` to `mine-b…` — unacceptable in a roster whose
job is to name which licence breached. The `delivered / commitment` line now sits under
the venture id (with the planet line) instead of beside it, and the rank sits inside the
movers' 18 px column. Rows are tall (height ∝ commitment), so the vertical axis was free
and the horizontal one was not. Ids fit at 1440/1600/1920 px.

**5. Copy.** The panel's notes said delivery is tracked per good and that the fee, breach
and pursue controls "are not shown at all, because there is nothing behind them" — both
now false. They say instead that each row is judged on its own, that the pile fills top
of the list first with each licence filled in full before the next is fed, and that a
licence reads met only when it got **all** of what it promised. The **fee** is still not
shown, and the note says so: the charge is Slice 3b-iii, and a fee figure that never
moves would read as live. The stale "Syndicate licence ROSTER — DESIGN-AHEAD" header
comment is rewritten; the top-up block stays tagged mock, and is now the only mock left
in the panel.

**Verified in headless Chromium** against a real server: two mines on titanium in one
system, both licensed (targets 6 and 4, `Q` 10), the send pinned to 2/tick so the window
ends 8 of 10 — a shortfall the ranking has to resolve.

```
default (establishment) order     after ▲ on mine-beta        next boundary, ranking held
 1 mine-alpha  6 / 6u  ✔ met       1 mine-beta   4 / 4u  ✔      1 mine-beta   4 / 4u  ✔
 2 mine-beta   2 / 4u  ! breach    2 mine-alpha  4 / 6u  !      2 mine-alpha  4 / 6u  !
```

Two different dots on two rows, each with its own delivered-vs-committed; the reorder
flips which licence is met; the flip survives a window roll; and `clear ranking` POSTs
`pursue: null` and restores the first column. Mid-window both rows read `accruing`; an
unlicensed producer reads `no commitment` with a neutral mark and no movers.

**437 tests, zero failures** — the total is unchanged (the four new assertions joined the
existing served-page test).

**Deferred, not invented:** drag-to-reorder (the movers are the established idiom in this
panel and one move is one POST; a drag would need the `trackDrag` rect-capture treatment
for a list rather than a track); and showing *which* rank a licence would need to be met,
which is a projection the engine does not emit and the browser is not allowed to compute.

---

## Revision — the player's licence panel goes live (27-08-26)

> The establishment popup's licence section stops being a labelled mock and calls the
> engine's real actions. **Client-only:** one file (`client/game.html`) plus two
> served-page tests in `sim/tests/server.test.js`. No engine, action, resolver or
> snapshot change; schema still 7; **no new `[FIRST-CUT]` number**.

**What was wrong.** The whole licence economy was built and reachable from the operator
console and the tests, but never from the game. `doDeploy` sent `establishVenture` alone,
and the panel said so on screen — *"Mock · no engine"*, *"None of it exists in the engine
yet"*, *"every venture is created with a commitment of zero, whatever this slider says"*.
A player who set a commitment and deployed got a bare unlicensed venture, which is why
the console's Syndicate panel correctly read **no commitment yet** for everything they
built. This slice is the seam.

**1. A licensed deploy is TWO actions.** `applyForLicence` licenses a venture that must
already exist, so the order is fixed:

```
POST /action  {"type":"establishVenture", …, "equityPct":0.25}
POST /action  {"type":"applyForLicence","guildId":…,"ventureId":…,
               "committedOutputPct":0.2,"windowDays":21}
```

Equity rides on the **establish**, because §5 makes it a term of the venture set at
establishment (Slice 3a), not a term of the licence. An **unlicensed** deploy is
unchanged: one action, no `equityPct` (the field is optional so its absence stays
byte-identical), no licence.

**The equity mapping.** The slider is whole percent, `0..EQUITY_CEIL`; the engine takes a
fraction in `[0, EQUITY_CEILING]`. The client sends `sliderPercent / 100`, which is the
same quantity as `S.o01 × EQUITY_CEILING` but lands exactly — so engine state records the
`0.25` the player chose and not `0.25000000000000006`.

**2. The two-step is NOT atomic, and says so.** There is no `establishAndLicence` action.
If the establish lands and the licence is then refused, the venture exists **unlicensed**,
and the receipt reports exactly that — the refusal's own `reason`, that nothing is
committed and nothing is sold, and (when one was offered) that the equity **is** recorded
on the venture but has no commitment sale to take a share of. It is never reported as a
success carrying terms the engine did not store. The client keeps every term inside the
range the engine validates, so this should be rare; rare is exactly when a client lies.
*Deferred, not built here:* a compound `establishAndLicence` engine action would close
the gap in one intake.

**3. The fee: an estimate before, the locked figure after.** The engine prices the basic
fee off the **posted** market price at the signing tick and locks it there, so no
pre-sign computation can be the number charged. The panel therefore shows only the
**relief** — §5's four-corner grid as a % of basic, labelled `estimate`, with a note
saying the credits are priced at signing. The fabricated `120 ¢/cyc` readout is **gone**.
After signing, the receipt prints the engine's own `discountedFee` / `basicFee` at
`lockedPrice`, read back off the snapshot, and states plainly that the fee is **locked
and not yet charged** (the debit is Slice 3b-iii, which is not built).
*Deferred, not built here:* an engine-side fee-preview endpoint would make the pre-sign
figure exact.

**4. The commitment preview is the engine's own arithmetic.** `round(pct × baseline × N)`
is exactly `commitmentUnitsFor`, and `N` is now read **live** off the snapshot's
`calendar.windowN` rather than mirrored — the client's `TICKS_PER_CYCLE` constant is
deleted. With no snapshot read the figure shows a dash instead of an invented number.

**5. The receipt reads engine truth.** `showSuccess` no longer echoes the sliders. After
`__refreshNow()` it looks the new venture up by id through a new `window.__myVenture`
(own ventures only, §7) and prints the **stored** `syndicateCommitment`, `equityPct`,
`licence.windowDays` and the locked fee. If the re-read does not bring the venture back
it says so rather than falling back to the panel's numbers.

**6. Every retired caption, and what replaced it.**

| retired | replaced by |
|---|---|
| Licence section `Mock · no engine` | `Real · sent to the engine` (the same tag the Configuration block already carried, now a shared `.mocktag.real` class rather than an inline style) |
| *"Everything below is the designed licence economy … **None of it exists in the engine yet**, none of it is sent on deploy, and every figure is a **[FIRST-CUT]** placeholder"* | a note saying the commitment, equity and window **are** sent and stored, and that the fee's *amount* is locked at signing while the curve is its designed *shape* |
| `Licence Summary` **Mock** tag | nothing — the summary is real; Committed / Equity / Renegotiate-in now carry the green `.real` key, and **Breach fee** carries its own inline `mock` marker (breach charging is not built) |
| fee readout `120 ¢/cyc` | `of basic`, with the graph headed `estimate` and a note that the credits are priced at signing |
| reputation, silently inside the blanket note | its own caption: design-ahead (#61), no standing recorded |
| `showSuccess`'s *"the licence terms above are not stored — the licence economy is not built yet"* | the stored terms, read back from the snapshot |
| adviser reel: *"The licence economy is not in the engine yet"*, *"every venture is created with a commitment of zero"*, *"no equity is recorded anywhere yet"*, *"No terms are stored yet"* | four pages that describe what actually happens now, each naming the one part still missing (the fee **charge**, and renegotiation) |

The **asset** picker is untouched and stays tagged `Mock · no engine` — the asset economy
is a separate unwired flow (§4, `assetId` reserved) and this slice deliberately does not
start it.

**7. Four mirrored constants, now tripwired.** The browser has no constants endpoint, so
the panel mirrors `EQUITY_CEILING`, the fee `CORNERS`, `EQUITY_SHAPE_K` and the mine
baseline. Duplication is only safe with a tripwire: a new served-page test asserts each
against `sim/licence.js` / `sim/baseline.js`, and asserts the sliders' own bounds against
`WINDOW_DAYS_MIN`/`MAX` and the ceiling. If an engine number moves, the test goes red
instead of the panel quietly showing the old one. `P.CORNERS` is keyed key-for-key with
the engine's object so the mirror is visible at a glance.

**Verified in headless Chromium** against a real booted server, driving the real
drill-down (system detail → planet manifest → the vacant node row):

```
LICENSED    commitment 20%, equity 25%, window 21 days
  panel     20% – 1,440/cycle · 25% · 86% of basic · locked at signing
  snapshot  syndicateCommitment 1440  (== commitmentUnitsFor(0.20, 5, 1440))
            equityPct 0.25 · committedFromTick 1
            licence { committedOutputPct 0.2, windowDays 21, signedTick 0,
                      lockedPrice 10, basicFee 7200, discountedFee 6184 }
UNLICENSED  one action, no equityPct
  snapshot  syndicateCommitment 0 · licence null
SYNDICATE   production…goods.titanium.window = { Q 1440, status accruing,
              perVenture: { …_n01: { commitment 1440, delivered 6, accruing } } }
              — the licensed mine only; the unlicensed one is not a licence-holder
PARTIAL     licence step refused: venture established, licence null, commitment 0,
              and the receipt says REFUSED / UNLICENSED with the reason
```

The console's Syndicate panel, which read *no commitment yet* before this slice, now
shows `commitment 1,440 u` and a live licence progress row for the mine established from
the game client.

**475 tests (+2), zero failures.**

**Out of scope and untouched:** the fee charge (3b-iii, engine), the asset economy, an
atomic compound action, and the operator console's own display fixes (the "hours"
mislabel, the preview offset, the icon, the tick-0 label) — a separate console slice.

---

## Revision — the TRADE tab goes live, SELL only (29-08-26)

The market tab stops being a stub. `openTab('market')` now renders the **TRADE panel**
(design.md §5, "SELL GOES LIVE"; look and interactions from
`docs/mockups/trade-panel.html`), and a guild can sell stockpile goods to the Syndicate
from it.

**Where it lives — the seam this note exists to pin.** The TRADE tab is the **game
shell's own overlay** (`#tabPanel`), not the embedded console and not a console hero
zone. It reads the snapshot `client/game.html` already polls and posts to `/action`
itself — exactly the licence-deploy path. There is **no `postMessage` bridge, no iframe
and no `console.html`** anywhere in it; that is the one thing the served-page tripwire in
`sim/tests/server.test.js` pins by scanning the `trade-tab-wire` block for those calls.
(The system-inventory hero next door *does* ride the venture bridge; the two are
deliberately different, and that tripwire is now scoped to the `ind-hero-wire` block so
the two rules cannot be confused.)

**What it reads (§7's player projection; the browser computes no game number):**

| On screen | Snapshot field |
|---|---|
| Holdings hero, grouped by tier | the player guild's `stockpiles` (guild-wide total), bucketed by `GET /goods` |
| resource chips + the posted value | top-level `prices[good]` (`null` ⇒ chip dimmed, not tradable) |
| the price chart | `priceHistory[good][resolution]` — **see the gap below** |
| the per-system sell rows | the player guild's `stockpilesBySystem[systemId][good]` |
| system names | the committed seed via the shell's own `systemById` |

**What it writes:** one action, built from the non-zero rows —

```
POST /action { type:'sellToSyndicate', guildId, good,
               allocations: [ { systemId, qty }, … ] }
```

There is **no guild-wide quantity box**: §5 makes the sale player-allocated per system,
so the card is an allocation table with a per-row Max and a running total. "You receive"
is a **display echo** of decision #43's `round(total × price)`; the authoritative figure
is read back off the snapshot `POST /action` answers with, and the notification quotes
that. A `{accepted:false}` is shown as its `reason` in the same small notification — a
normal outcome, not an error. On success the panel re-reads `/snapshot`, so Holdings,
the HUD credits and the posted value update in place. Selection (tier + good) is held
across polls; the rows rebuild only when the system set changes, so a poll never eats a
half-typed quantity.

**Deferred, and rendered as dimmed placeholders, not faked:** BUY (a shipment to one
destination — it needs §6's transport), the guild-to-guild **Open Market** book (Phase 3;
its sort/scroll chrome is cosmetic and carries no invented listings), and Your Listings.

> **CLOSED 29-08-26 — the gap below is history.** The price-history engine landed
> (`sim/price-history.js`) and the chart is finished; see the revision note at the foot of
> this file for what the chart does now. The section is kept because the *reasons* it gives
> — read the resolution vocabulary from the data, don't invent a base — are the discipline
> the finished chart still follows.

**THE GAP — the price-history engine slice has not landed.** Nothing in `sim/` writes a
`priceHistory`, and the snapshot carries none, so:

- the chart holds an honest **"gathering history…"** empty state per good (the same
  convention the console's trend sparklines use) — no history is faked or seeded;
- the **resolution keys** (the scale buttons) are read from the `priceHistory` block
  itself rather than named here, so whatever vocabulary that slice settles on is what
  the panel shows. It renders nothing until there is a block;
- a sample may be a bare number or a `{posted|price|value}` row — both are read, so the
  panel does not pin a shape that slice has not chosen;
- the mockup's dashed **"base ¢10"** reference line is deliberately **not drawn**:
  `BASE_PRICE` is an engine constant the snapshot does not publish, and the browser may
  not type a game number of its own. Publishing it is a snapshot question, not this
  slice's to answer.

**One recorded deviation from the mockup.** The mockup's 2×2 grid forces equal rows; the
built panel makes the top row flex and the SELL card size to its own content
(`grid-template-rows: minmax(180px,1fr) auto`), so a guild holding a good in six systems
gets a card that fits instead of an inner scrollbar the mockup never had.

**575 tests (+17), zero failures.**


---

## Revision — the TRADE chart is finished (29-08-26)

Client-only. The chart was built before `priceHistory` existed, so three things were
provisional and one was a bug. All four are closed; no engine, snapshot or action changed.

**1. The scale buttons are the designed 3D / 2W / 1M / 3M.** They used to be the raw ring
keys read off the snapshot (`fine` / `medium` / `coarse`) — honest at the time, since the
engine had not named a vocabulary. The mapping is **ruled in `docs/phase-1-tuning.md`** and
mirrored in the panel verbatim, not re-derived:

| Button | Reads | Window |
|---|---|---|
| **3D** | `fine` | all 288 samples |
| **2W** | `medium` | all 168 samples |
| **1M** | `coarse` | its most recent **30** samples |
| **3M** | `coarse` | all 90 samples |

`coarse` serving **both** 1M and 3M, at different windows, is precisely why the buttons
could not stay as the ring keys — three rings, four buttons.

**Button visibility follows the fill-forward rule.** A button is offered only when its ring
actually holds samples, because the rings fill forward from deploy and there is no backfill
(`phase-1-tuning.md`). So a young galaxy shows **3D alone**; **2W** joins once `medium` has
a sample (~2 hours in), **1M** and **3M** once `coarse` does (~1 day in). Offering a button
that draws nothing would be the panel promising history the galaxy has not lived. A good
with no samples at all keeps the "gathering history…" empty state. The selection is held
across polls and falls back to the **finest available** scale — never to nothing.

**2. The reference line is drawn, from `priceBase`.** The mockup's dashed "base" mark is
back: `snapshot.priceBase[good]`, read **per good** even though the engine's value is
uniform today, so the per-good ruling needs no client change. It is folded into the chart's
y-range, so it cannot be clipped off the moment the price runs away from base. **No base in
the snapshot ⇒ no line** — the chart degrades exactly as the mockup does, and the browser
still types no number of its own.

**3. The scale-row / footer collision is fixed.** The chart card is a flex column whose
chart area is the elastic part (`flex:1 1 0`); the head, scales and foot had the default
`flex-shrink:1`, so when the column ran short the **scales row was compressed to 16px around
a ~27px button**, which then painted over the footer. Invisible until PR #42 gave the row
buttons to hold. All three are `flex:0 0 auto` now — only the chart area gives up space. The
old `min-height:14px` on the row was never the constraint (it sat below the button's own
height) and is gone rather than raised.

**4. Full width.** `#tp-trade .tw-wrap` goes `max-width:1440px` → **`max-width:none`**. The
two hero columns keep their fixed widths and the centre 2×2 absorbs the rest, so a wider
screen buys chart and allocation room instead of margin. `docs/mockups/trade-panel.html`
carries the same change in the same commit, so the contract and the build agree.

**Verified** in headless Chromium at 1920×1000 against a 45,000-tick galaxy (all three rings
populated): the buttons read `3D/2W/1M/3M` with no ring key on screen, 1M drew the last 30
coarse samples against 3M's 31, the base line sat at `¢10.00` and vanished when `priceBase`
was removed, the scale row measured 41px with the button inside it and no footer overlap,
and `.tw-wrap` computed `max-width: none` at 1876px of a 1920px viewport.

**591 tests (+1), zero failures** — client-only, so no golden could move.

**Not done here, and why:** the chart's aspect ratio. Full width makes the chart card wider
without making it taller, so the plot is flatter than the mockup's. No target ratio is ruled,
and the top row's height trades directly against the SELL card's (which was sized
deliberately last slice), so this is a judgement call for the human rather than a silent
adjustment. BUY, the Open Market book and shipments stay deferred and untouched.

---

## The Establish-Venture panel goes real — the asset picker + honest copy *(31-08-26, client-only)*

`sim/actions.js` has required an explicit `assetId` since the named-asset slice, and this
panel was still running on a four-row **mock** inventory (`AST-114`…) that sent nothing — so
**every deploy from the game client was being refused**. This slice closes that: **client-only**,
`client/game.html` plus the mockup and served-page tripwires; **no `sim/` change**, no new
action, **schema still 7**, and no new number (`ESTABLISH_RATE` and the four mirrored
constants are untouched).

**1. The picker is the real inventory.** The `INVENTORY` mock is **deleted**. `applySnapshot`
keeps the player guild's own `assets` rows (`LIVE.myAssets`), and a new bridge
`window.__myIdleAssets(kind)` returns the ones the engine reports **idle**
(`deployedToVentureId == null`) of the matching kind — `miner` for a resource node, `factory`
for a settlement slot. The label comes from `kind` and the condition from
`Math.round(maintenanceCondition * 100)`: every figure is the engine's, and the browser
**re-derives nothing** — least of all idle-vs-deployed, which `sim/snapshot.js` already answers
(§7's display rule). Option shape is unchanged (`Miner · asset_… · 100%`).

**2. The picked machine rides the deploy.** `establishVenture` now carries
`assetId: S.asset.id`. `gate()` already required a picked asset; it now means something.

**3. Deploy is gated to systems the guild HOLDS.** §4 gate 3 is a real engine rule, so the
panel stops implying otherwise: the button is **disabled** on an unheld or unclaimed site with
the reason in `deployHint`, and the territory line says you can only deploy in a system you
hold. The engine's refusal stays the **backstop** — `failHint('Refused: ' + out.reason)` is
untouched and surfaces `does not hold system …` verbatim if anything reaches it. This
**overrules** the old panel stance ("establishing here is allowed; leasing is not built yet"),
which was written before the gate existed.

**4. The empty pool is the CLIENT's message.** The engine no longer has a "you have no idle
miner" refusal — it speaks only about the id it was handed — so the panel owns it: a disabled
`— no idle {miners|factories} in inventory —` option, the deploy button disabled, and a hint
saying every machine of that kind is already deployed.

**5. Every retired string.** `— your own claim.` · the Asset mocknote · the licence explainer
note ending *"not the figure you will owe"* · the fee-graph `Indicative.` gnote · the label tail
*"— % of basic, across commitment"* and its `estimate` tag · the reputation `design-ahead (#61)`
gnote · **every** `Mock · no engine` tag. Each is pinned **absent** in
`sim/tests/server.test.js`.

**6. What de-mocking forced us to fix rather than hide.** Removing a tag from something still
fake would be worse than leaving it, so three things changed with the tags:
- **The Breach row** carried a `mock` tag and a fabricated credit figure off a client-side
  `P.BASIC_FEE` table. Breach *is* the full basic fee, and the basic fee is not knowable in
  credits until the engine locks it at signing — so the row now reads in the same **relative**
  form the Fee row uses (`100% of basic · locked at signing`) and `P.BASIC_FEE` is deleted.
- **The `Real · sent to the engine` tags** were only meaningful opposite the mock ones. With
  the mocks gone they are orphaned noise, so both went together (with their CSS classes) —
  and so did the summary ledger's green *"this row is real"* key, which is the same
  distinction in quieter form: with the Asset row real too, a green subset would now imply
  the rest is somehow less true. It also puts the ledger back in step with the mockup,
  which never carried that marker.
- **The asset adviser reel** said the machine "will be consumed", that the inventory was a mock,
  and that a well-kept machine "runs closer to its rating". All three were false — §4 rules
  **occupy, not consume**, the inventory is live, and **condition never touches production**.
  Rewritten to say exactly that, plus the held-system rule.

**Verified** in headless Chromium against a real booted server, driving the real drill-down
(system detail → planet manifest → a vacant site row): the picker listed the guild's 15 real
idle Miners with real ids and condition, a settlement slot listed its 10 Factories; picking the
**fourth** miner POSTed that `assetId`, the venture came back running it, that machine flipped
to deployed and left the picker while a different idle one stayed; with all ten Factories
deployed a slot showed the disabled empty state and deploy stayed disabled; on an unheld system
the button was disabled with its reason and the same deploy forced through the API was refused
by the engine; and none of the removed strings rendered. No page errors.

**646 tests (+2), zero failures** — client-only, so no golden could move.

## Revision — the licence basic fee reaches the snapshot: `feeQuote` *(31-08-26, engine-only)*

The Establish-Venture panel can say what a licence costs only as a **percentage of basic**,
because the credit figure is `FEE_RATE × the good's droidless baseline × windowN × the
posted price` and the client deliberately holds none of those pieces — the discipline that
retired the old hardcoded `P.BASIC_FEE` mock. So the **engine publishes the number**.

**`feeQuote`** — a new top-level snapshot field, `{ [good]: basicFeeCredits }` over the
priced goods: the **BASIC (un-discounted) licence fee, in integer credits**, that a venture
producing that good would be charged if it signed **now**, at the **posted** price and the
**window in force** (`state.windowN`, defaulted exactly as the licence path defaults it).

- It is computed by **calling `licenceFee` itself** (`sim/licence.js`) over
  `baselineUnitsForGood` (`sim/baseline.js`, the per-good inverse of the venture-keyed
  `baselineOutputFor`) — the formula is **not** re-derived in `sim/snapshot.js`. One
  function produces both the quote and what `applyForLicence` locks, so the display cannot
  drift from the contract; a test pins that equality for a **mine** and a **factory**.
- **Basic only.** The commitment × equity relief depends on the player's live slider
  values, which a snapshot cannot know — the client already draws that curve. Publishing a
  discounted figure here would be guessing the player's terms.
- **Live, not locked.** A signed licence keeps the fee it locked however far the market
  moves (that is what makes timing a signature a decision); `feeQuote` is the price of the
  *next* signature and moves with the posted price. A panel showing both must not blur them.
- A good is **omitted** rather than quoted at zero when it has no producible baseline or the
  state carries no price row for it. Today every priced good has a baseline, so the map is
  the full 28 — `deuterium_fuel` (§8) and the Tier-3 placeholders are absent because nothing
  can make them.
- **Additive; schema stays 7** — a new top-level key changed no existing shape, the same
  call `prices`, `priceHistory`, `priceBase` and `calendar` each made. Pure derived
  telemetry: no serialized byte, no determinism hash, so **no golden moved**.

**Engine-only.** No client change ships here — wiring the credits figure into the panel (in
place of, or beside, the `% of basic` line) is the next slice, and it is the panel's own
job to apply the player's chosen relief to the published basic.

**657 tests (+11), zero failures.**

## Revision — the Establish-Venture panel shows the fee in real credits *(31-08-26, client-only)*

The snapshot publishes `feeQuote` (the previous revision), so the panel no longer has to
speak in percentages. **Client-only** — `client/game.html`, the mockup's matching row shape
and served-page tripwires; **no `sim/` change**, no action change, **schema still 7**, and
**no new number**.

**The two ledger rows are credits now.**

| row | before | now |
|---|---|---|
| **Fee** | `74% of basic · locked at signing` | `5,089 ¢` |
| **Breach fee** | `100% of basic · locked at signing` | `7,200 ¢` |

- **Breach fee** = `feeQuote[good]` — the whole basic fee, because a shortfall voids the
  discount outright (§5). It does **not** move with the sliders.
- **Fee** = `round(feeQuote[good] × fp/100)`, where `fp` is the same four-corner relief the
  graph already draws — so the number and the curve can never disagree, and the row updates
  live as the player drags. This is the panel's **only** arithmetic: the basic is the
  engine's own `licenceFee` output, not a figure the browser priced.
- Read through a narrow bridge, `window.__feeQuote(good)`, exactly as `__windowN` reads the
  cycle length — the panel holds no snapshot of its own.
- **Graceful absence:** no quote for the good (nothing produces it, or no price row) shows
  **`—`**, never `NaN ¢` and never a `0` that would read as a free licence.
- Plain numbers, as settled: **no `≈`**, no "at current price", and **no "locked at
  signing"**. The quote is live and firms up at the tick you sign; the receipt already
  reports the figure the engine locked.

**Untouched, deliberately:** the unlicensed rows (`0 ¢` / `n/a`), the relief graph and its
`feePctBig` "% of basic" readout — a percentage is the curve's natural unit — the receipt,
and every other row.

**One copy fix rode along**, because it became false the moment the rows changed: the deploy
confirmation said the fee *"cannot be quoted before"* signing. It now says the ledger figure
is the engine's quote at the current price, fixed against the price at the tick the licence
is filed. The header block's `ESTIMATED — shown, never sent` note becomes `QUOTED — read,
never sent` for the same reason (its wished-for "fee-preview endpoint" is the snapshot field).

**Verified** in headless Chromium against a real booted server (seed 4242), driving the real
drill-down (system → planet → a vacant Titanium node → Establish): Licensed at 0/0 read
**7,200 ¢ / 7,200 ¢** and matched `window.__snapshot().feeQuote.titanium`; at commitment 60% /
equity 25% the Fee moved to **5,089 ¢** while Breach stayed 7,200 ¢; unlicensed still read
`0 ¢` / `n/a`; and **deploying then licensed the venture at exactly those figures** — the
engine locked `basicFee 7200`, `discountedFee 5089`. No page errors from the panel.

**658 tests (+1), zero failures** — client-only, so no golden could move.


## Revision — fuel becomes real and gets a credit value: `fuelHoardValue` *(31-08-26, engine-only)*

Fuel Slice 1. Until now `guild.fuelHoard` was a real, validated, snapshot-exposed field
that was **always zero**, because `foundGuild` forced it there — minting fuel into a hoard
needed a fuel-genesis rule that had not been ruled. It has been: a founding guild opens with
a **baseline hoard** (the early-game *starter floor*, `docs/fuel-economy.md` §7, anchored on
`design.md` §8's survival floor) so a new guild is not born into the no-fuel → no-trade →
no-reputation trap. `fuelHoard` therefore stops reading `0` on every player card in the
client, with **no client change and no new snapshot reader** — the field was already wired.

**`fuelHoardValue`** — one new field on each guild row, beside `fuelHoard`: the hoard
**marked to market in integer credits**, `Math.round(fuelHoard × FLAT_FUEL_PRICE_PER_UNIT)`.

- The rate is a **named `[FIRST-CUT]` constant in `sim/fuel.js`**, not a number inlined in
  the snapshot. It exists because fuel is the one good the price engine **never** prices
  (`design.md` §8 — there is no `state.prices.deuterium_fuel` row, ever), so a client that
  wanted the hoard in credits could only invent the rate. The engine owns it instead (§5's
  display rule: the browser renders, the engine decides), and the real fuel price controller
  (`docs/fuel-economy.md` §9, open question 4) replaces this one constant when it lands.
- **Nothing charges it.** No credit moves through this field — it buys nothing and sells
  nothing — so invariant 2 cannot see it. Pure derived telemetry: no serialized byte, no
  determinism hash.
- **Additive; schema stays 7** — nothing existing changed shape, so every current reader
  keeps working and an older one ignores the new key. The same call `syndicateSale`,
  `perVenture`, `licenceFee`, `shipments` and `feeQuote` each made; the v3/v4 bumps were for
  growth *inside* existing rows, which this is not.

**Engine-only.** No client change ships here. The four `GOLDEN_*` hashes in
`sim/tests/persist.test.js` **did** move — the canonical dev sequence founds a guild — and
were re-pinned; the scenario goldens in `commitment-scaffold.test.js` did **not**, because
`createGuild` was deliberately left alone and scenario guilds still pass their own hoards.

**664 tests (+6), zero failures.**

## Revision — what a trade costs in fuel: `fuelCost` *(31-08-26, engine-only)*

Fuel Slice 2 (`docs/fuel-supply-and-allocation.md` §8). Slice 1 gave every guild a real `fuelHoard`;
this one lets the client say what spending it would cost, **before** the player commits. The burn is
`distance × rate` over seed geometry the browser does not hold, so — like `feeQuote` before it — the
number cannot be derived client-side and the engine publishes it.

**`fuelCost`** — one new map on each guild row: `{ [systemId]: { fuelBurn, creditCost } }`.

- **Held systems only.** A Syndicate delivery goes only to a system you hold (`design.md` §6, enforced
  by `buyFromSyndicate`'s `guildHolds` gate), so a quote for anywhere else would price a trade the
  engine would refuse. The list comes from `heldSystemIds` (`sim/claims.js`), which reads the same claim
  rows through the same predicate that gate does — the plural of one question, not a second question.
- **Keys arrive sorted** (invariant 9). The client renders them in the order given; it should not sort.
- **`fuelBurn`** is integer fuel units, `Math.ceil`'d so every real route costs **at least 1** — a 1-hex
  trip is 0.5 fuel and would otherwise truncate to free. **`creditCost`** is `fuelBurn ×
  FLAT_FUEL_PRICE_PER_UNIT`, the Slice-1 `[FIRST-CUT]` display rate. Both are integers ≥ 0.
- **`{ fuelBurn: 0, creditCost: 0 }` means NO ROUTE, not a free one** — no waystation can reach that
  system. The client should read it as unavailable, not as a bargain. (Today no seed system hits this;
  the shape is honest anyway.)
- **Cargo-independent, and quoted per route, not per order.** The burn does not move with the good or
  the quantity, so one row serves every trade into that system. `routeFuelCost` takes a systemId and
  nothing else, so the client cannot make it depend on cargo even by asking.
- Computed by **calling `routeFuelCost`** (`sim/fuel.js`), never re-derived here — so what the panel
  shows and what Slice 3 will deduct come out of one function. A test pins the snapshot's rows equal to
  the function's output for every held system.
- **Additive; schema stays 7** — nothing existing changed shape, the same call `fuelHoardValue`,
  `feeQuote`, `shipments` and `licenceFee` each made. Pure derived telemetry: no serialized byte, no
  determinism hash, **and nothing is charged** — the deduction is Slice 3, so no golden moved.

**Engine-only.** No client change ships here; the BUY confirm popup wires it when the BUY UI slice
lands. `buyFromSyndicate` is untouched — it still derives its route inline (`sim/actions.js`), which is
Slice 3's to wire.

**676 tests (+12), zero failures.**

## Revision — fuel bites, and the SELL panel says what it costs *(31-08-26, engine + client)*

Fuel Slice 3 (`docs/fuel-supply-and-allocation.md` §8). The engine half is BUY-only: a Syndicate BUY
now burns `routeFuelCost(destinationSystemId).fuelBurn` and refuses a guild that cannot pay it. The
client half lands in the **SELL panel**, because that is the only live Syndicate trade UI — the BUY
control is still `class="tw-mbtn na"`, and its confirm popup (with its own fuel row) belongs to the BUY
UI slice.

**The Fuel row** (`#tw-fuelcost`), between the unit total and the proceeds line:

- Summed across the allocation rows the player has actually filled in, from
  `guild.fuelCost[systemId]` — the Slice-2 snapshot map. **The browser computes nothing**: it holds no
  seed geometry and no burn rate, and a served-page tripwire asserts the string
  `SYNDICATE_HAULER_BURN_RATE` / `hexDistance` / `nearestWaystation` appears nowhere in `game.html`.
  Both `fuelBurn` and `creditCost` are read off the row; the credit figure is not a multiplication done
  here.
- A row whose system carries **no `fuelCost` entry counts 0** rather than throwing — the no-route case,
  which the engine refuses on its own terms anyway.
- Short fuel turns the row red (`.tw-fuelline.short`), disables the Sell button, and notes
  **"Not enough fuel — need X, have Y"** — the same two numbers the engine's own refusal names. It is a
  **pre-gate, not the gate**: the engine is always the authority, and this only spares a round trip.

> ⚠ **The short-fuel disable is ahead of its engine rule, and blocks sales the engine would accept.**
> SELL burns nothing in this slice — that deduction is deferred pending the multi-allocation routing
> ruling — so a guild whose hoard is below the displayed burn is stopped by the panel from a sale the
> engine would happily take. Worse, nothing refills fuel yet (issuance is unbuilt), so a guild that
> burns down on BUYs can be left unable to use its only working trade action. Built as specified, and
> flagged rather than quietly softened: the fix is either to drop `|| short` from the Sell button's
> `disabled` and keep the row as information, or to land the SELL deduction that makes the gate true.
> The next slice settles the ruling either way.

**Engine-side**, for readers of this file: `fuelHoard` on the snapshot now *moves*, so a panel showing
it should re-read after every trade rather than caching it. `fuelCost` is unchanged from Slice 2.

**689 tests (+13), zero failures.** Verified in headless Chromium against a real booted server: the
Fuel row read `3 fuel · ≈ ¢30` and matched the snapshot; 166 real BUYs burned the hoard 500 → 2 (every
one through `POST /action`, which asserts all nine invariants after each apply); the 167th was refused
with *"insufficient fuel: need 3, have 2"*; the panel then disabled with that same message; and a
completed SELL left `fuelHoard` untouched at 2.
