# Prompt: Galactic Economy Game — Phase 1 (Playable Sandbox)

> **Provenance note (added 17-07-26):** this is the working prompt as written on 16-07-26, versioned verbatim so it can't drift or go stale in a chat window. Its Stage 1 (read-and-report) was delivered the same day; findings were merged into `docs/design.md` in the 17-07 consolidation, and the live checklist state lives in `docs/roadmap.md`. Two details are superseded by that consolidation and tracked there: the design doc's file is `docs/design.md` in this repo, and `spacecraft_routing.md` (referenced below) does not exist — §15.6's route-segment constraint governs instead. Section references (2, 5, 10, 15, 17, 18) remain valid against `docs/design.md`.

*Paste everything below the line. `fuel_market_simulator.xlsx`, `generate_seed.js`, and `seed.json` are already in the project files — Fable can read them directly. If your Fable session isn't scoped to this project, attach `Design_and_Technical_Summary.md` and `fuel_market_simulator.xlsx` manually.*

---

## Context

I'm building a real-time, persistent, self-hostable web game — a galactic economy where each player runs a Guild. I have limited programming experience and am learning JavaScript as I go. I will read every line you write. If I can't understand it, it's not done.

`Design_and_Technical_Summary.md` is the project's master document and **the contract you are building against**. Section 15 in particular (conventions, entities, invariants, tick order) is a spec, not a suggestion. Where your instincts and that document disagree, the document wins — or you stop and tell me it's wrong. Don't silently do it your way.

The document's Section 18 is about how I want to work with you, and I mean it: you are stateless, the repo is the only memory this project has, and I would rather have a small correct thing plus honest tests than a large plausible thing.

## Why this prompt differs from the roadmap's Phase 1

Section 17 scopes Phase 1 as a narrow economy toy — one guild, one venture, one bot — with territory, tolls, and everything spatial deferred to Phase 4. **I'm deliberately widening that.** I don't just want to prove the economic model works on paper-turned-code; I want to *play* it and feel whether the concept holds up as a game, not just as a simulation.

That widening has a real cost I'm accepting knowingly: this Phase 1 still won't prove the two things that make this a persistent multiplayer game rather than a single-player toy — **persistence** (state surviving across sessions, Phase 2's job) and **real player-vs-player trust and betrayal** (Phase 3+'s job, since a bot's disposition score is not a mind on the other side of a negotiation). Those gaps stay open. What I'm buying instead is an earlier, honest answer to "does the *shape* of this game feel right to actually play" — territory worth holding, tolls worth negotiating, a squeeze worth fighting — before I sink more time into infrastructure for a game I haven't felt yet.

**The trap to avoid:** "territory and tolls" does not mean building the real hex galaxy. That's Section 2/15's `{q,r}` coordinate system, the seed generator, Toll Gates anchored at specific hex ranges, and the full per-leg piracy/trespass routing schema — genuine Phase 4 machinery. Building that now would mean Phase 1 quietly becomes Phase 4 wearing a different label. Instead:

**Fake the geography. Keep the economics real.**

Territory is an abstract graph for this phase — a handful of named systems as nodes, routes between them as edges, no coordinates, no hex math, no spatial rendering beyond maybe a simple node-and-line diagram. Ownership, tolls, and venture placement on that graph are real, fully-functional mechanics — not stubs, not mockups. The literal galaxy, real coordinates, Toll Gate placement rules, and per-leg risk rolls from `spacecraft_routing.md` stay out. This is the whole trick: get the *feel* of contested territory and toll negotiation without secretly building Phase 4's spatial engine to do it.

## The goal

**I can sit down, play a session as one guild against several bot guilds, and feel a real fuel squeeze happen — with territory ownership, tolls, and ventures as levers I can actually use to cause or resist it.**

The fuel-squeeze scenario from `fuel_market_simulator.xlsx` — five guilds, a deliberate squeeze, the Stockpiler ending up poorer than the Refiner who just produced steadily — stays in scope, but its role changes. It is no longer the finish line; it's an **internal correctness check** embedded in the sandbox: proof the economic core is right before I trust anything built on top of it. The finish line is the session itself being worth playing.

## Scope

**In — real, playable mechanics:**
- Guilds: one player-controlled, several bot-controlled, each with credits, fuel hoard, influence.
- Ventures: production, buy/sell, energy draw from the shared fuel pool, automation parameters (Section 5).
- The fuel utility: reserve, price formula (below), baseline allocation.
- **Territory, abstracted:** a small graph of systems. Ownership is claimable/contestable. A territory owner can set a **toll** on routes through their systems and a **tariff** on resource extraction — real numbers, real negotiation, per Section 2's "three distinct economic levers."
- **Bot guilds with disposition**, per Section 10: standing interests + a disposition modifier that moves only on costly actions, decays toward neutral, and is capped so it bends a vote or a toll negotiation but never owns it. This is what makes negotiating with bots feel like negotiating rather than clicking a slider.
- `currentTick`, fast-forward, and enough UI to see territory, tolls, prices, and guild states at a glance, and to intervene.

**Out, still:**
- The real hex galaxy, `generate_seed.js`, `seed.json`, coordinate math, and the System & Planet Index UI.
- Real vehicles/ships, Toll Gates as literal single-hex claims, and the per-leg piracy/trespass routing schema from `spacecraft_routing.md`. Route risk in this phase, if it exists at all, is a flat abstract number per edge — not a rolled, geometry-aware outcome.
- The council, votes, legality rulings, the storyteller, the narrative layer (Rebellion/Ancients).
- Persistence between sessions (Phase 2) and real multiplayer (Phase 3).

## Build it so it doesn't have to be rebuilt

The abstract territory graph is a **stand-in for Phase 4's real geography, not a permanent design.** Build the territory/toll logic behind a boundary — ownership checks, toll calculation, tariff calculation — that doesn't know or care whether "system A" is a graph node or a real hex system. When Phase 4 replaces the graph with the real galaxy, the economic and negotiation logic underneath should not need to change, only what feeds it coordinates. If you can't see how to keep that boundary clean, say so in Stage 1 rather than discovering it in Phase 4.

## Known tensions — resolve these in Stage 1, don't paper over them

1. **The fuel price formula is open question #2.** Port the spreadsheet's curve exactly; do not design one. Ground truth, transcribed from the `Setup` and `Simulation` sheets, in case you can't read the file directly:

   ```
   price = clamp(
     basePrice * (targetReserve / max(1, stockpileStart)) ^ sensitivity,
     floor,
     ceiling
   )
   ```

   | Lever | Value |
   |---|---|
   | Base price | $5 |
   | Target reserve (equilibrium stockpile) | 30 |
   | Price sensitivity (exponent) | 0.6 |
   | Price floor | $2 |
   | Price ceiling | $40 |
   | Income per guild per turn | $100 |
   | Starting market stockpile | 30 |

   | Guild | Archetype | Fuel need/turn | Production capacity | Starting credits | Starting hoard |
   |---|---|---|---|---|---|
   | Refinery Combine | Refiner | 8 | 40 | $120 | 0 |
   | Vantar Trust | Stockpiler | 5 | 6 | $250 | 0 |
   | Orun Compact | Trader | 4 | 4 | $120 | 0 |
   | Dracis Concern | Manufacturer | 12 | 8 | $100 | 0 |
   | Ilyra Holdings | Small guild | 3 | 3 | $60 | 0 |

   If the spreadsheet's actual formula ever disagrees with this transcription, **the spreadsheet wins** — tell me about the discrepancy rather than silently picking one.

2. **How big is the graph, and how many bot tiers does it need?** Section 10 defines four bot tiers; tiers 3–4 (NPC filler factions, autonomous AI guilds) are almost certainly overkill for a single-player sandbox. Propose the smallest graph (how many systems, how many bot guilds beyond the five-guild squeeze roster) and the smallest bot tier (likely 1–2) that still makes territory and tolls feel like real decisions rather than a formality.

3. **What does "contesting" territory mean without a council?** Section 2's legality system — blockades, defiance, council votes on whether an action was legal — is out of scope this phase, but Section 2 also says territory can change hands "through conflict, negotiation, or economic pressure" without needing the full legal machinery. Propose the smallest honest version of contest/negotiation that doesn't require inventing a combat system or a court.

## Hard constraints — unchanged from the narrow version, and non-negotiable

**1. The tick loop is a pure function: state in, state out. No DOM access inside it, ever.**

Section 14 claims every line of JavaScript already written will run unmodified on a Node server in Phase 2. That's only true if it's true here. Rendering reads state; it never lives inside the loop.

**2. All eight steps of §15.6's fixed order exist as named functions from day one**, in order, even though several are stubs this phase: `1 production → 2 consumption/energy → 3 price recompute → 4 scheduled events → 5 arrivals → 6 baseline allocation → 7 storyteller → 8 vote closures`. Territory contest and toll negotiation are **player/bot actions**, resolved on the right-hand side of §15.6's table, not new tick steps — don't invent a ninth step without telling me why the existing eight don't cover it.

**3. Invariants before features.** There is currently no `package.json` and not one test in this project. Before the sandbox, build the harness: invariants 1 (conservation of fuel), 2 (conservation of credits), 3 (non-negativity), and 9 (determinism) assert **every tick** and halt loudly with the tick number and the offending values. A silent violation is worse than a crash. Invariant 3 needs a per-field decision (fail vs. floor-and-record-shortfall) — the spreadsheet floors and records; ask me where it's ambiguous.

**4. Never invent a number.** This document has 43 open questions. Every constant you cannot source from the document or the spreadsheet goes in a table (below) and gets flagged, not chosen. This now explicitly includes any territory/toll numbers — tariff defaults, toll negotiation ranges, disposition decay rates — since none of those have real values anywhere yet.

**5. Conform to §15.2.** Integer credits, never floats. Integer fuel and goods. The word is `guild` — never faction, house, or player. Stable unique IDs. Every mutation records its tick.

**6. Small enough to read.** Prefer boring, obvious code over clever code. Comment the *why*, not the *what*. If a file passes a few hundred lines, tell me why it needs to. This scope is bigger than the narrow version — watch that "bigger scope" doesn't become an excuse for "bigger files."

## Work in three stages. Stop at each gate.

**Stage 1 — Read and report. Write no implementation code.**

Deliver:
- **A reconciliation.** The attached code and the document may disagree; the document claims some work is finished that I'm not certain is in the repo. Tell me exactly what exists, what the document claims exists, and where they diverge. Don't fix it yet.
- **The plan** — the sandbox you'd build, files, the tick loop's shape, the territory-graph boundary design, and your answers to the three tensions above.
- **The invention table** — every constant, formula, or rule you'd need that isn't in the document or the spreadsheet, with what you'd need from me. I expect this to be the most valuable thing you produce all session, and it's bigger this time — territory and tolls have almost no numbers defined anywhere yet.

Then stop. I'll answer before you build.

**Stage 2 — The harness, then the walking skeleton.** Tests first. Then the smallest loop that ticks: enough guilds and one venture each to prove production, pricing, and one territory claim with one toll all work end to end. It must halt on an invariant violation and produce byte-identical state at tick N across two runs from the same starting state. Show me it running before you scale it up.

**Stage 3 — The sandbox.** Scale to the full guild roster and territory graph. Reproduce the spreadsheet's squeeze as the internal correctness check (price ~$5 → ceiling, Manufacturer in shortfall, Refiner finishing richer than the Stockpiler). Then give me a real session: claim territory, set and negotiate tolls with bot guilds whose disposition actually shifts, fight or profit from a squeeze using territory and tolls as tools, not just production and stockpiling.

## Definition of done

- [ ] Tests exist and run. Invariants 1, 2, 3, 9 assert every tick and halt loudly.
- [ ] Same starting state, run twice, byte-identical at tick N.
- [ ] The tick loop is pure and has no DOM access. All eight §15.6 steps are named functions in fixed order.
- [ ] The squeeze reproduces the spreadsheet's three signature results, as an internal check.
- [ ] I can play a session: claim/contest territory, set/negotiate tolls and tariffs with bots, watch disposition move, and respond to or cause a squeeze.
- [ ] The territory/toll logic sits behind a boundary that doesn't assume the abstract graph — swapping in real hex geography later shouldn't touch it.
- [ ] **The document is updated in the same delivery as the code** — what this phase taught, what #31's answer turned out to be, what #2's formula actually is now, any territory/toll numbers now decided, and an explicit note that Phase 1's scope was deliberately widened and why, so Phase 4 doesn't get confused about why territory already half-exists.

## Output

Working code I can run in a browser, the test harness, the invention table, and the document diff. When you're unsure, ask. I would much rather answer three questions than discover an invented rule in six weeks.
