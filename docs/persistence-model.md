# Starfare — persistence & server-runtime model (Phase 2)

> Status: design ruling, 19-08-26. Companion to design.md §14 (Architecture) and
> roadmap.md Phase 2. This pins HOW live state is held and made durable; it does
> NOT yet pin the Postgres table schema or the server directory layout (both are
> separate, still-open slices — see "Deferred" below). When this doc and the
> engine disagree, the engine wins and this doc is the bug (§18 rule 2).
>
> Phase 2 is NOT started (entry = Phase 1 done). This is an on-paper ruling
> captured now so the eventual build reads the real decision, not a chat paraphrase.

## The ruling

The server holds the authoritative live state **in memory** and advances it there
each tick — the existing `sim/` loop, run unmodified (design.md §14: "moving
trusted code from a browser tab to an always-on server"). PostgreSQL is the
**durability layer, not the working surface.** This is "Option B" over "Option A"
(DB-as-truth). Two durability mechanisms sit under it:

1. **Snapshot** — the full in-memory state is written to Postgres periodically,
   inside one transaction (the all-or-nothing write that answers invariant 4 /
   atomicity). Default cadence: **every tick**. Cadence is a tunable dial (see
   below). The snapshot **overwrites** — only the latest is needed for restore, so
   it is one small latest-state record, not a growing archive.
2. **Action journal** — every incoming action is appended to a durable log **before**
   it is applied in memory. On a successful snapshot the journal is **truncated**
   (those actions are now baked into the snapshot), so at per-tick cadence it never
   holds more than one tick's worth of actions — a tiny rolling buffer, not a
   second copy of history.

Call the whole thing **B+**: in-memory compute, per-tick snapshot, action journal.

## Recovery guarantee

- **Graceful shutdown** (deploy, reboot): a shutdown hook saves then exits. Trivial.
- **Hard crash** (power loss, OOM, panic — no hook runs): on restart, load the last
  snapshot, then replay the journalled actions since it. **Zero action loss.**

The snapshot alone restores the world to the last tick boundary; the journal
recovers the actions submitted *after* that boundary. They cover different gaps and
neither is redundant with the other — dropping the journal reopens the crash-window
action loss; dropping snapshots makes restart replay the whole history from genesis.

**Hard dependency:** journal-replay is only exact because the tick is deterministic
(invariant 9). Determinism is load-bearing for this design, not just a test nicety.

## Snapshot cadence — the one tunable dial

Frequency trades write-volume against restart-replay time. Every tick → the journal
stays a 1-tick bridge and restart replays ≤1 tick (simplest restart logic). Every N
ticks → fewer writes, journal holds N ticks, restart replays ≤N ticks (still
milliseconds, determinism makes replay cheap). Default **per-tick**; turn it down
only if per-tick writes ever matter (they do not on the target hardware).

## Why Option A (DB-as-truth) was set aside

Option A makes the database the live working surface (the tick reads/writes it each
turn). Its advantages, and why each was judged non-decisive here:

1. **Live state readable by other processes via SQL.** Non-decisive: at a one-minute
   tick a tick-stale snapshot read is a complete admin/analytics view — "live to the
   second" is not a meaningful unit when the world resolves per minute.
2. **No crash-window action loss.** Neutralised: the action journal gives B+ the same
   zero-loss property.
3. **Truth always on disk, restarts trivial.** Covered: shutdown hook (graceful) +
   journal replay (hard crash).
4. **SQL query power + multiple concurrent writers.** Non-issue at scale: leaderboard/
   history queries are microseconds of JS over a few hundred guilds, and one process
   owning one galaxy is the desired shape anyway (run many galaxies as many processes).

The deciding cost of A is that it would require the pure in-memory loop to query the
DB field-by-field, discarding the "port, not rewrite" property that is Phase 2's
whole entry premise.

## Hardware footnote (measured, not estimated)

Against the real 1500-system seed: parsed seed ~11 MB; a generous 300-guild live
state (5 systems each, dense 28-good stockpiles, 5 ventures, 3 vehicles) ~7 MB; whole
Node process ~68 MB RSS. RAM is a non-constraint — this runs comfortably on a 1–2 GB
Raspberry Pi and luxuriously on a real server. The Pi's only real concern is flash
write-wear (mitigated by an SSD and/or delta-saves); irrelevant on the target
self-hosted server hardware.

## Status note — a file-based prototype now exists (24-08-26)

The **B+ shape below has a working, opt-in, FILE-backed prototype in the testbed
dev rig** (roadmap Phase 1 Stage 2): `sim/persist.js` (a full-state snapshot via
atomic temp-file+rename, plus an append-only action journal) wired into
`sim/server.js` behind `STARFARE_PERSIST_DIR`. It follows this doc's B+ shape —
in-memory compute, per-tick snapshot, write-ahead action journal, replay-on-restart
— against **JSON/JSONL files, not Postgres**, and the pure `sim/` loop runs
unmodified. It is explicitly the DEV RIG, **not** the Phase-2 production server:
Postgres, the table schema, multi-galaxy, and auth all remain deferred exactly as
below. The prototype settled the double-apply/truncation question in practice
(journal entries carry their apply tick; replay filters `tick >= loadedState.tick`,
so a **non-truncated** journal is idempotent-safe and truncation stays an optional
size optimisation — see the last Deferred bullet).

**The SEED joined the save — 25-08-26 (galaxy-lifecycle Slice A).** The durable unit
is no longer state+journal alone: the active galaxy is the trio
`{ seed.json, state.json, journal.jsonl }` in `STARFARE_PERSIST_DIR`. The geometry
used to be baked into the image (`data/seed.json`, the same galaxy every deploy);
now a galaxy generated at runtime persists with the state it belongs to, so
"start a new game" is an operator button rather than a redeploy. `sim/persist.js`
gained `saveSeed` (same temp-file + rename atomicity as `saveState`), `loadSeed`
and `deleteGalaxy`. Two consequences for durability: an **empty volume now means
NO GALAXY**, not the baked default (`docs/galaxy-lifecycle.md`, Decision 1); and
boot carries a **consistency guard** — a state whose `world.seed` is not the
volume seed's number is an interrupted Create, never loaded as a pairing (see the
lifecycle doc's amended Atomicity note for what it does instead).
`data/seed.json` stays committed as the generator's reference fixture and the
default for a run with no volume.

## Deferred (separate slices — do NOT treat as decided here)

- **The Postgres table schema.** Transcribes the STORED half of the live-state model
  (guilds, stockpiles, production-profile, syndicate-windows, ventures + batch_carry,
  vehicles, claims, single-row galaxy state, price_history). DERIVED values
  (galacticSupply, audit) are never columns. To be pinned in its own slice.
- **Server directory / Docker layout.** Evolves the existing repo (one repo, not a
  second) — `sim/` stays the pure engine, a server/persistence layer is added, a
  Postgres service joins the existing image. To be pinned in its own slice.
- **Snapshot cadence value**, full-snapshot vs delta-save, and whether to keep a
  permanent (non-truncated) action journal for audit/anti-cheat/replay — a feature
  choice separate from durability. All go to the decision checklist, not guessed.
