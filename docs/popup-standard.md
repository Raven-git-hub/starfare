# Popup standard — the adviser-reel card

*Ruled 09-09-26 (#64 client-polish). This is THE standard shape for every modal popup
message in the client — Syndicate offers, storyteller beats, adviser confirms, and any
future "the game is telling you something / asking you to decide" surface. New popups
copy this; they do not invent their own chrome. Point a build prompt at
`docs/popup-standard.md` and this whole contract comes with it.*

The live, canonical implementations (read these, don't reinvent):
- **`#est-reel`** in `client/game.html` — the adviser reel: help pages, the deploy-confirm,
  and the shared `__adviserConfirm` yes/no. The single-action (Next / Cancel) form.
- **`#reneg-overlay`** in `client/game.html` — the licence-renegotiation popup. The
  two-action decision form (ACCEPT / REJECT).
- **`docs/mockups/guild-hall-messages.html`** — the committed visual contract (the mock).

Both overlays are the SAME visual object; they are kept as separate elements/ids on
purpose (one popup can open another — REJECT on `#reneg-overlay` opens `#est-reel` as its
lapse confirm — so they must not share a node). "Same look, own element" is the rule when
a new popup can co-exist on screen with an existing one.

---

## Anatomy — the reel card

A centered overlay holds ONE **`.reel-card`**: a two-column grid, **text left, character
hero art right**.

    overlay        position:fixed; inset:0; background:rgba(6,7,10,.80);
                   backdrop-filter:blur(3px); display:flex (centered); padding:26px
    .reel-card     width:100%; max-width:760px; height:min(80vh,600px);
                   display:grid; grid-template-columns:1fr 300px;
                   background:linear-gradient(180deg,#141821,#0F1218);
                   border:1px solid var(--line2); border-radius:14px; overflow:hidden;
                   box-shadow:0 30px 90px rgba(0,0,0,.65)

**Left column — `.reel-text`** (`display:flex; flex-direction:column; padding:30px 30px 26px`):
- **`.reel-eyebrow`** — who is speaking / the topic. `var(--mono)`, 10px, `letter-spacing:.18em`,
  uppercase, `color:var(--amber)`, `margin-bottom:12px`. (e.g. "Guild Adviser", "Syndicate Liaison".)
- **`.reel-title`** — the headline. `var(--serif)` (Cinzel) 600, 25px, `color:var(--ink)`,
  `line-height:1.2`, `margin-bottom:18px`.
- **`.reel-body`** — the scrolling content. `flex:1; overflow-y:auto`, 15px, `color:var(--ink)`,
  `line-height:1.75`; `p{margin:0 0 16px}`; `em{color:var(--amber); font-style:normal}`.
  This is where the prose, any terms table, and footnotes live — it scrolls; the foot does not.
- **`.reel-foot`** — pinned action row. `display:flex; align-items:center;
  justify-content:space-between; gap:14px; padding-top:20px; margin-top:14px;
  border-top:1px solid var(--line)`. Left: dots (multi-step reel) OR a mono status line
  (a popup that fires an action). Right: **`.reel-actions`** (`display:flex; gap:12–14px;
  margin-left:auto`).

**Right column — `.reel-art`** (the hero panel, 300px):

    .reel-art          position:relative; overflow:hidden; background:#0d0f14;
                       background-size:cover; background-position:50% 12%;
                       background-image:url('assets/characters/<portrait>.jpg')
    .reel-art::before  content:""; position:absolute; inset:0;
                       background:linear-gradient(90deg, #141821 0%, rgba(20,24,33,0) 26%)

The `::before` left-edge fade bleeds the card colour into the portrait so the seam
disappears. Portraits live in `assets/characters/` — currently `advisor.jpg`,
`engineer.jpg`, `pilot.jpg`, `plantmanager.jpg`. A speaker with no portrait yet reuses
`advisor.jpg` and the new-portrait need is logged as a deferred decision — **never invent
a new asset in a build**.

**Close control.** The reel has no header bar. When a popup needs an explicit close (`×`),
put it in the card corner: **`.reel-close`** — `position:absolute; top:14px; right:14px;
z-index:2; 28×28; border:none; background:none; color:var(--ink3); font-size:20px`; hover
→ `var(--ink)`. (The card must be `position:relative` for this.)

---

## Buttons

All reel buttons share one base: `var(--mono)`, 11px, `letter-spacing:.08em`, uppercase,
`border-radius:8px; padding:9px 18px; cursor:pointer; transition:.12s`.

- **Primary / affirmative (amber)** — ACCEPT, Next, Confirm. `color:var(--amber);
  background:var(--amber-ghost); border:1px solid var(--amber-dim)`; hover →
  `background:var(--amber-dim); color:var(--void)`.
- **Destructive (red)** — REJECT, and any lapse/close/delete decision. Same outlined shape
  as the amber primary, red-keyed: `color:var(--red)` (#C2603A);
  `background:rgba(194,96,58,0.10)`; `border:1px solid rgba(194,96,58,0.55)`; hover →
  `background:var(--red); color:var(--void)`. *(The palette has no `--red-ghost`/`--red-dim`
  token; those two literal rgba values are the red analogues of `--amber-ghost` (0.10 fill)
  and `--amber-dim` (border) — derived from `--red`, NOT new sourced numbers. If a red
  token is ever added to `:root`, swap these for it.)*
- **Ghost / dismiss** — `.reel-cancel`: a low-emphasis "Close" for a non-decision reel.
  `color:var(--ink3); background:none; border:none; padding:9px 4px`; hover → `var(--ink)`.

Two decisive actions (accept + destructive) sit side by side, equally weighted, both
outlined. A single dismissible reel uses ghost cancel + amber next.

---

## Behaviour & content rules

- **The client computes no game number (design.md §5, §15.2).** Every value shown is read
  straight off the snapshot; the adviser prose is *copy*, keyed on emitted state (e.g. a
  standing band → a voice string). A popup never does arithmetic on game state.
- **Same look, own element.** A popup that can appear over another popup gets its own
  overlay id (see `#reneg-overlay` vs `#est-reel`). Layer with z-index so the opener sits
  under the thing it opens; keep an existing overlay's z-index when restyling it.
- **Preserve wiring on a restyle.** Restyling an existing popup is CSS + a markup reshuffle
  only — keep every element id the driving JS wires, and leave the JS untouched. Prove it
  (grep the ids; confirm no JS hunk).
- **Mobile.** `@media(max-width:820px){ .reel-card{grid-template-columns:1fr}
  .reel-art{display:none} }` — the hero drops, the text goes full width.

## Palette tokens used (from `client/game.html` `:root`)

    --void #0B0D12   --ink #E8DFC8   --ink2 #8B8F9C   --ink3 #565B68
    --line rgba(232,223,200,.10)     --line2 rgba(232,223,200,.20)
    --amber #C9A227  --amber-dim #7A6420  --amber-ghost rgba(201,162,39,.10)
    --green #4E9A87  --red #C2603A
    --mono 'IBM Plex Mono'           --serif 'Cinzel'

## When NOT to use a reel popup

Inline, non-modal surfaces stay as they are — the MESSAGES rail list, the HUD, the
Standing gauges, ledger lines. The reel is for a *modal moment*: a message that wants the
player to read it and, usually, decide. Don't wrap a passive readout in one.
