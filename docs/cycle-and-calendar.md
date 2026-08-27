# Starfare — the cycle and the calendar (RULED 27-08-26)

> **One-line ruling.** A Syndicate commitment **cycle is one 24-hour day = 1,440 ticks**
> (tick = 1 min, RULED 24-08-26). This promotes the window length `N` from its placeholder
> `[FIRST-CUT] 24` to **RULED 1,440**, anchors every cycle boundary to **server midnight**
> through a single per-galaxy offset set once at creation, and defines a small **calendar
> layer** (`dayOf` / `minuteOf` / `tickAt`) that derives days, minutes and a human
> `DDDD:TTTT` notation from the plain tick — so transports, the storyteller and licence
> renegotiation all schedule against one timeline. **The engine stays clock-free and
> deterministic; the tick stays a plain monotonic integer.**

This doc is the contract for two build slices (§7). It supersedes the `N = 24` placeholder
in `sim/windows.js` and `phase-1-tuning.md`, and folds the ruling into `design.md` §5.

## 1. Why 1,440, not 24 — a derived number, not an invented one

The window length was always meant to be a day. `phase-1-tuning.md` recorded `N` as
`[FIRST-CUT] 24` with an explicit standing note: *"design says a window is ≈24h, and with
tick-duration ruled at 1 min/tick that is 1,440 ticks — pending confirmation the window is a
full day, 24 stays a guess."* The `24` was a memorable placeholder, never a tuned figure, and
it was left un-promoted only because the "is a cycle a full day?" question had not been
answered out loud.

It is now answered (27-08-26): **a commitment cycle is one full 24-hour day.** With the tick
ruled at 1 minute, that is **1,440 ticks**. This satisfies the never-invent-a-number rule
(§18 #5): `1,440` is *derived* — `24 h × 60 min/h ÷ 1 min/tick` — from two ruled facts, not
guessed.

**What the number drives.** A venture's commitment is
`round(committedOutputPct × baselineUnitsPerTick × N)` (`commitmentUnitsFor`, `sim/licence.js`).
Titanium's type baseline is 5 units/tick (`MINE_BASELINE`), so a **100 % titanium licence owes
5 × 1,440 = 7,200 units per cycle** — where before it read `5 × 24 = 120`. Every commitment
figure on the console was a derivative of `5 × 24`; they all become derivatives of `5 × 1,440`.
The basic fee scales with `N` on the same axis (`FEE_RATE × baseline × N × price`,
`licenceFee`), so the `0.10` *ratio* the fee is tuned on is unchanged — only the absolute grows,
by design (the `FEE_RATE` note in `phase-1-tuning.md`).

**A related fact, flagged so it is not a surprise later.** `baselineUnitsPerTick` is the
**type** baseline (`MINE_BASELINE[good]`), *not* the venture's own `productionRate`. A mine
established below its type baseline structurally cannot deliver a 100 % commitment (it owes the
type's daily output but produces less). That is existing behaviour, unchanged by this ruling; the
client's `ESTABLISH_RATE` is currently `5`, matching the titanium baseline, so a normally-
established titanium mine can exactly meet its commitment. Per-resource extraction rates remain a
separate open tuning item.

## 2. The midnight anchor — the engine stays clock-free

Today a cycle boundary is `tick % N == 0`, counted from `tick 0` = the moment the galaxy is
created. The boot clock (`sim/server.js`) is a plain 60-second interval that knows nothing about
wall-clock time, so a galaxy created at 14:30 rolls its cycle at 14:30 every day — not at
midnight.

**Ruling.** Cycle boundaries are anchored to **server midnight**. The boundary becomes:

    (tick − dayAnchorTick) % N == 0

`dayAnchorTick` is a per-galaxy integer offset, **set exactly once** from a **single wall-clock
read at galaxy creation**, chosen so the first boundary falls on the **next server midnight**,
then **frozen and persisted** with the galaxy. After that one read the engine consults no clock:
`advance` / `tick` / `resolveProduction` read only `tick` and `dayAnchorTick`, both integers in
state. The lone wall-clock read lives at the creation seam, exactly like `STARFARE_TICK_MS` — it
is operator/boot territory, never the pure tick. Determinism (invariant 9) and the §5 clock-free
rule are preserved: **no `Date.now()` ever enters the tick path.**

**`dayAnchorTick` defaults to `0`.** Since `(tick − 0) % N == tick % N`, every scenario, test and
golden that sets no anchor is **byte-identical** to today. Only a live galaxy, created from the
admin panel, sets a non-zero anchor. (Proven locally: `437/437` with `N = 1,440`, and the
boundary/`winStartFor` outputs are identical at `anchor = 0` across a spread of ticks.)

## 3. Downtime — no catch-up, drift accepted (RULED)

If the container is down, the counter simply **pauses and resumes** where it left off. **Cycles
stay exactly 1,440 ticks — never stretched, never skipped.** What loosens is only the *label*
"this boundary happens to be real-world midnight": every outage nudges the galaxy's midnight later
relative to the calendar by however long it was down, and **nothing catches up**. The galaxy, in
Andy's words, "loses the time spontaneously."

This is deliberate and it is the *deterministic* choice. The alternative — fast-forwarding ticks
on reboot to stay locked to real midnight — would require the boot clock to keep consulting and
reconciling against the wall clock, dragging real time back into a system whose whole determinism
story rests on the tick being pure. Drift keeps the engine clock-free.

**Re-anchoring is a manual, future operator action** ("resort to last known midnight"), never
automatic. Grace periods for downtime-sensitive mechanics, if ever needed, are backend automation
layered on top — not a change to the tick. A server with a large outage is expected to organically
work itself out, or to be re-anchored by hand if it matters.

## 4. Partial first cycle

A galaxy created mid-day has a **stub first cycle** (creation → the first midnight, fewer than
1,440 ticks), then full 1,440-tick days after. This is absorbed by the **existing mid-window
pro-rate** (`committedFromTick` / `windowFraction`, `docs/mid-window-pro-rate.md`): a licence
signed in the stub owes `round(commitment × present/N)` for that first window, the same machinery
that already handles a mid-window join. **No new mechanism** — the anchor's stub is just another
partial window. Confirmed acceptable 27-08-26.

## 5. The calendar layer — derive the day from the tick, never encode it into it

A tempting alternative was floated and **rejected**: pack the day and minute into the tick counter
itself as a decimal `DDDDTTTT` value (`00001439` = day 0, minute 1439; `00010000` = day 1,
minute 0). It reads beautifully, but it makes the counter *look* like a number while breaking the
arithmetic the engine does on it in **52 places** — `next.tick = state.tick + 1`,
`signedTick + 1`, `winStartFor = tick − ((tick−1) % N)`, `tick % N == 0`. Under decimal packing,
`+1` needs a carry rule (`00001439 + 1` must become `00010000`, not `00001440`), `%` no longer
finds the boundary, and — the killer — **elapsed time is silently wrong**: a transport departing
`00001439` and arriving `00010001` computes `00010001 − 00001439 = 8562`, when the real elapsed is
`2`. Every `+`, `−` and `%` would become decode → compute → re-encode-with-carry, in exactly the
systems (transports, storyteller schedules) the format exists to serve. The readability is paid for
by corrupting the most common time operation.

**The tick stays a plain monotonic integer.** The calendar is a **pure derivation** on top of it —
about six lines, no stored state beyond the anchor already introduced in §2:

    minuteOf(tick)        = ((tick − 1 − dayAnchorTick) % N + N) % N
    dayOf(tick)           =  Math.floor((tick − 1 − dayAnchorTick) / N)
    tickAt(day, minute)   =  dayAnchorTick + day * N + minute + 1
    format(tick)          = `${pad4(dayOf)}:${pad4(minuteOf)}`   // "DDDD:TTTT" — DISPLAY ONLY

**The `(tick − 1)` phase is load-bearing.** It is the same phase the engine's `winStartFor`
already uses (`tick − ((tick − 1) % N)`) and the same "boundary tick is the window's **last**"
rule (§5): so the calendar's day-roll and the engine's met/breach boundary are the **same event**,
by construction, and can never disagree. The first **producing** tick (engine `tick 1`) reads
`0000:0000`; the boundary tick (`N`, `2N`, …) reads minute `N−1`, the day's last — matching "…`1439`
is the last tick of the first day." (The raw engine `tick 0` is the pre-game initial state and is
never displayed.)

**`DDDD:TTTT` is a display notation, never a stored value.** Storage is always the plain integer
tick; the UI converts to whatever it wants — real arrival times, countdowns, renegotiation
deadlines — using `dayAnchorTick` plus the server clock at render time (the conversion the UI was
always going to do anyway).

**What this unlocks — the reason to build it now.** Events schedule at a concrete tick:
`tickAt(42, 0)` is "day 42, midnight"; a transport arriving "day 7, minute 1230" is
`tickAt(7, 1230)`. Countdowns and ETAs are a plain subtraction (`target − now`) — correct, because
the counter is contiguous. **Transports, the storyteller and renegotiation deadlines all consume
this one timeline API** instead of three bespoke time hacks.

## 6. `windowDays` reconciled — it is the *other* window

`windowDays` (7–42, passed at `applyForLicence`) is **not** the accrual cycle. It is the
**renegotiation window** — how long a contract's terms are locked before either side may reopen
them — and it has been stored-and-inert only because "resolve days → a tick" was undefined while
the cycle length itself was a placeholder. The calendar defines it now:

    renegotiationDeadline(licence) = tickAt( dayOf(signedTick) + windowDays, 0 )

— a day-aligned tick, `windowDays` daily boundaries after signing. **The formula lands here; the
behaviour does not.** Detecting the deadline and actually reopening the terms remains open question
**#64**; the calendar merely turns renegotiation from an undefined unit-conversion puzzle into a
straightforward scheduled-event consumer of `tickAt`.

**On the shared word "window."** The accrual cycle (`windowN`, a day) and the renegotiation window
(`windowDays`) are orthogonal: a licence **delivers-or-breaches every cycle (day)**, and its
**terms are locked for `windowDays` days**. A `windowDays = 7` licence meets-or-breaches daily for
seven days, after which its terms may be reopened. Keep the two senses distinct in prose.

## 7. Determinism, and the build sequence

**Determinism holds.** `dayAnchorTick` defaults to `0`, so every test/scenario/golden is
byte-identical (`(tick − 0) % N == tick % N`); the number-flip needs **no golden regeneration**
because every test sets its own `state.windowN` (verified: `437/437` at `N = 1,440`). The single
wall-clock read lives at galaxy creation (`sim/server.js`), never in `advance`/`tick`/`resolve`.
Invariant 9 and the clock-free rule (§5) are intact.

Two sequential vertical slices (§18 #3):

- **Slice 1 — the number.** `FIRST_CUT_WINDOW_N` `24 → 1,440` in `sim/windows.js`, and promote the
  `phase-1-tuning.md` entry to **RULED 1,440**. Trivial and safe; immediately playtestable
  (`setWindowN` still overrides for short test cycles). Effect: `120 → 7,200`.

- **Slice 2 — the anchor + the calendar.** Add `dayAnchorTick` (default `0`, persisted); change the
  boundary to `(tick − dayAnchorTick) % N == 0` and thread the anchor through `winStartFor`; add the
  pure calendar module (`dayOf` / `minuteOf` / `tickAt` / `format`); have galaxy creation set the
  anchor from one wall-clock read to the next server midnight; **no catch-up** on reboot. Prove the
  `anchor = 0` no-op (goldens byte-identical) and add the calendar/anchor tests. The `windowDays`
  renegotiation **behaviour** stays #64 — only the `renegotiationDeadline` formula is defined here.
