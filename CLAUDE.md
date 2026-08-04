# CLAUDE.md — Starfare

Read this before doing anything. This file is loaded automatically at the
start of every session — local or cloud. It is a condensed pointer to the
real rules, which live in the repo itself.

## The repo is the only memory
Sessions are stateless. docs/design.md and docs/roadmap.md are the sole
continuity between sessions. Read them before relying on anything you recall
from a prior session, a summary, or this file. If this file and the docs
disagree, the docs win — tell the human and stop.

## Two authoritative documents
- docs/design.md   — DESIGN. On design questions, it wins.
- docs/roadmap.md  — STATUS. On what phase we're in and what's done, it wins.
Code is checked against design.md. If code and design.md disagree, that is a
bug in one of them — fix it and update the doc in the SAME commit.

## State the roadmap item first
Before writing any code, say which roadmap item you're working on. If it
isn't on the roadmap, stop and ask — don't invent scope.

## Sequential vertical slices only
Work one module at a time, end to end. Never parallelize across modules —
the seams between systems are the hard part and this project has nobody
whose job is to own a seam.

## Never invent a number
Any constant, formula, or rule not already in docs/design.md or explicitly
given by the human goes to docs/roadmap.md's decision checklist instead of
being chosen. Flag it, don't guess it.

## Conventions (docs/design.md §15.2)
- Integer credits. Integer goods. Never floats for either.
- The word is `guild` — never faction, house, or player.
- Manufacturing TIERS, not phases.
- Stable, unique IDs.
- Every mutation records its tick.

## Tests are the tripwire, not review
Write tests that fail loudly. Unsure what to test? Check the nine invariants
in docs/design.md §15.5. A silent violation is worse than a crash — halt and
report the tick number and offending values, don't quietly continue.

## Code style
The human is learning JavaScript and reads every line. Prefer small, clear,
obviously-correct code over large plausible code. Comment the *why*, not the
*what*. If a file passes a few hundred lines, that's worth flagging, not
just doing.

## How work lands (cloud/web sessions)
Never push to main. Work on a branch and open a PR — this is the review
gate. The PR description should say: which roadmap item this addresses,
what changed, what you'd want the human to look at first, and any open
question that belongs on the decision checklist instead of being answered
silently.

## Doc and code move together
The docs/roadmap.md and/or docs/design.md update for this change ships in
the SAME commit/PR as the code it describes — not a follow-up.

## Repo boundary
Only work inside this repository. Do not read, reference, or modify
anything from sibling repositories on the same host account, even if you
believe it's relevant — ask the human first.
