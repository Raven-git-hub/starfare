# Mockups — the visual source of truth (references, not wired code)

These files define how the client should LOOK. They are VISUAL references only:
match the look, but wire every value to the live schema-7 snapshot and compute NO
game number (design.md §5). The hand-coded mock data models inside them are NOT to
be copied — see each build prompt.

## The authoritative set

- **starfare-client-full.html** — the **frozen master reference**: the whole client
  assembled (splash → connect → galaxy map → system/planet detail → the System
  Manifest with its production console → the heroes). This is the "follow exactly"
  spec for how the screens compose and look. **Do not edit it** — it is the spec,
  not the build. The living build is `client/game.html`.
- **console_restructure.html** — the **authoritative console design** (the System
  Manifest's production console). Note the file holds TWO layouts: an earlier
  5-column flow, and an **appended restructure block** (`<style id="restructure-css">`
  + `<script id="restructure-js">`) that overrides it — "last declaration wins". The
  **restructure is the design**: a 3-zone frame `[celestial | console | industrial]`
  and, inside the console, a 3-column flow at `7fr 15fr 10fr` — Production │
  Distribution │ Consumption/Syndicate — with the trend cards folded onto the venture
  stacks, the two top-up squares in the stockpile row, and the Syndicate tab's
  thermometer + roster. The served `/console` (`client/console.html`) must match THIS.
  If the full-client's embedded console and this file ever differ, **this file wins**
  for the console.
- **venture-establishment.html** — the establishment-popup design (the licence
  economy shown here is design-ahead / mock; the real wire is `establishVenture`).

## Current state (25-08-26)

`client/console.html` **matches `console_restructure.html`** (its restructure block):
the 3-zone frame, the 7:15:10 flow, the trend cards, the top-up squares, the Gate-1
arm panels and the Syndicate tab. It is a re-skin onto the live schema-7 snapshot —
the design file's own mock backend was NOT carried across, and every figure is read
from the engine. Three deliberate deviations, all recorded in `docs/client-wiring.md`:
the **throttle** sits on the consumer chip in the central column (the mockup parks it
in the industrial hero, which embed mode drops — that would leave the System Manifest
with no throttle); the trend sparklines are **never seeded** (they start empty and fill
from real polls, showing "gathering history…" until two ticks are observed); and the
licence **roster** + the hero's **facility** block are tagged **MOCK** on screen,
because the engine has no licence layer, droids or assets to feed them.

## Removed

- **console_mock6_1.html** — the earlier *plain* console draft. Superseded by
  `console_restructure.html` and removed because the old README wrongly named it the
  target, which is what caused the console to be built to the stale design. Still in
  git history if ever needed.
