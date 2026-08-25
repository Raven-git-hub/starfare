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
  Manifest's production console): the symmetric 5-column flow (Production │ pipe │
  Distribution-centre │ pipe │ Consumption), the trend columns, the top-up
  triangles, and the Consumption / Syndicate tab with its thermometer + roster. The
  served `/console` (`client/console.html`) must match THIS. If the full-client's
  embedded console and this file ever differ, **this file wins** for the console.
- **venture-establishment.html** — the establishment-popup design (the licence
  economy shown here is design-ahead / mock; the real wire is `establishVenture`).

## Current state (25-08-26)

`client/console.html` presently matches the **old, plain** console (the superseded
draft below), which is why the deployed System Manifest looks wrong. It is being
rebuilt to `console_restructure.html`. Until then, deployed ≠ spec for the console.

## Removed

- **console_mock6_1.html** — the earlier *plain* console draft. Superseded by
  `console_restructure.html` and removed because the old README wrongly named it the
  target, which is what caused the console to be built to the stale design. Still in
  git history if ever needed.
