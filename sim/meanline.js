'use strict';

// meanline.js — THE MEAN LINE: the reputation a guild of a given size is expected to
// have earned, and the fuel-issuance modifier that reads one against the other.
//
// docs/points-and-reputation.md §3 (the formula, the modifier, the empty-guild guard and
// the slice-4 ruling), §0 (the one-line frame), §4 (ownership).
//
//     expectedRP = MEANLINE_K × GP
//     gap        = guildRP − expectedRP
//     modifier   = clamp( 1 + ISSUANCE_SENSITIVITY × gap / expectedRP, FLOOR, CEIL )
//
// THIS IS THE JOIN, and it is the whole point of the two halves that came before it. GP
// (sim/points.js) is how BIG a guild is; RP (sim/licence.js, stored on the guild) is how
// much it CONTRIBUTES. Neither decides anything alone. Here they meet: **fuel issuance =
// your RP judged against the RP expected for your GP**, so bigger guilds are held to a
// higher standard and **size alone earns nothing — it raises the bar you must clear**.
// That is §0's "the storyteller targets the comfortable", as pure economics.
//
// WHY A MODULE OF ITS OWN, and not sim/fuel.js. §4 rules that the FUEL LAYER owns the
// mean line and the modifier; it does not say which file, and "the fuel layer" is a
// concept rather than a filename. fuel.js is scoped, by its own header, to the founding
// grant, the flat display price and the route burn QUOTE — the mechanics of moving and
// pricing fuel — and it states in as many words that the issuance model "is NOT built; do
// not read any constant below as a stand-in for it". Issuance is a different rule with
// different inputs (it reads Points and reputation, and no geometry at all), so it gets
// its own home for the same reason `sim/points.js` did: a constant lives in the module
// that owns the rule it belongs to, and folding this into fuel.js would have meant
// rewriting that file's scope note and pushing it past 250 lines.
//
// ── IT READS. IT NEVER WRITES. ── §4: "the FUEL LAYER owns GP, the mean line, and the
// issuance modifier. It READS `guild.guildReputation`; it does not author it." Nothing in
// this file mutates state, and nothing in it decides how RP moves — that is the licence
// layer's job (sim/licence.js), and the day these two disagree about what a met cycle is
// worth, the licence layer is right.
//
// ── AND IT GRANTS NO FUEL. ── `fuelGranted = baseGrant × modifier` needs `baseGrant`,
// which is the pool/price slice (§8, fuel-supply-and-allocation.md) and is NOT built.
// This slice computes the modifier and publishes it; **nothing consumes it**. It is
// watchable, and that is deliberately all it is — the same standing GP had when it landed
// one slice ago.

const { guildPoints, systemPoints } = require('./points.js');

// MEANLINE_K — the reputation expected per Point of size.
//
// `[FIRST-CUT]` **1**, ruled in phase-1-tuning.md §"Points & Reputation".
//
// ⤳ RESCALED 01-09-26 (150 → 1), points-and-reputation.md §2.6. The old 150 existed for
// exactly one reason: it bridged two quantities on very different scales — RP resting in
// the THOUSANDS against a GP in the TENS (12 a system, 6–8 a venture). §2.6 removes the
// need for the bridge instead of tuning it, by moving the GP weights and `REP_MEET_MAX`
// onto the same small scale RP now lives on (200 a system, 100–150 a venture; a met cycle
// worth 10). With both halves on ONE scale, `k = 1` and **a guild's expected RP simply
// EQUALS its GP** — the mean line reads at a glance, and there is no third number to keep
// in sync.
//
// THE SHAPE IS UNTOUCHED, and that is the load-bearing claim: `issuanceModifier` divides
// the gap by the expectation, so it is SCALE-INVARIANT (see below). Par, floor and ceiling
// behave exactly as calibrated; only the digits shrank. "Par" is still about three
// ventures per held system — 3 × 100 against 200 + 3 × 100 — because the RATIO W_SYS :
// W_T1 was preserved at 2 : 1 across the rescale.
const MEANLINE_K = 1;

// The modifier's three knobs, all `[FIRST-CUT]` (phase-1-tuning.md).
//
// PUNISHING FOR AMBITION, ruled 31-08-26 and the reason SENSITIVITY rose 1.0 → 1.5 and
// FLOOR fell 0.5 → 0.3. The two together lean the curve against expanding faster than you
// can back it up: grabbing a system or deploying a venture raises `expectedRP` AT ONCE
// (GP jumps the moment the claim row or the venture exists) while the reputation to pay
// for it has not been earned, so the guild draws ~floor for the cycles it takes to climb.
//
// THE ASYMMETRY IS THE DESIGN: a 0.3 floor against a 1.5 ceiling means **falling below
// your line hurts more than rising above it helps**. It is not a symmetric band and
// should not be tidied into one.
//
// NOT A DEATH SPIRAL, and the floor is what makes that true: a below-line guild still
// draws 0.3 of its base grant, and `GUILD_STARTING_FUEL` (sim/fuel.js) is the other half
// of the safety net. Over-expansion stings; it does not kill.
const ISSUANCE_SENSITIVITY = 1.5;
const ISSUANCE_FLOOR = 0.3;
const ISSUANCE_CEIL = 1.5;

// expectedReputation(state, guild) -> the RP a guild of this size is expected to have
// earned. An INTEGER, and integral by construction: an integer `MEANLINE_K` times the
// integer `guildPoints`, with no rounding anywhere (the same guarantee sim/points.js
// makes about its own weights — a fractional `k` would silently produce a fractional
// expectation, so a test pins that this one is whole).
//
// NON-NEGATIVE, always: `guildPoints` cannot be negative (its weights are positive and
// its counts are non-negative), so this is ≥ 0 and is 0 exactly when GP is 0 — which is
// what makes the `=== 0` guard below both exact and sufficient.
//
// PURE: reads `state.claims` and the guild's ventures through `guildPoints`, mutates
// nothing, stores nothing. There is no `guild.expectedReputation` field and deliberately
// none — like GP, this is recomputed on read, so it cannot drift from the holdings and
// the reputation it is derived from, and it reaches no serialized byte.
function expectedReputation(state, guild) {
  return MEANLINE_K * guildPoints(state, guild);
}

// issuanceModifier(state, guild) -> the multiplier a future fuel grant would be scaled
// by. A float in `[ISSUANCE_FLOOR, ISSUANCE_CEIL]`, and one of the model's few sanctioned
// non-integers: it SCALES a quantity, it is not itself credits or goods, so §15.2's
// integer rule does not reach it — exactly the standing `equityPct` and `batchCarry`
// have.
//
// RATIO-BASED, hence SCALE-INVARIANT (§3): the gap is divided by the expectation, so a
// guild twice the size needs twice the reputation to sit in the same place, and the same
// curve serves a two-venture guild and a fifty-venture one. That is what stops the
// modifier from becoming a de facto size bonus.
//
// THE EMPTY-GUILD GUARD (§3, open question #7). `GP = 0 → expectedRP = 0`, and
// `gap / expected` would divide by zero — so `expectedRP === 0` returns exactly **1.0**,
// ruled. It is the right answer rather than a dodge: a guild holding nothing is trivially
// ON its own line, draws the neutral base grant, and no new-guild death spiral opens.
// `=== 0` is exact because the expectation is non-negative (above), so there is no
// negative case hiding behind a `<= 0`; and 1.0 sits inside `[0.3, 1.5]`, so the neutral
// answer needs no clamping to be legal.
//
// It READS `guild.guildReputation` — the stored guild total the licence layer authors and
// `checkGuildReputationSum` guards every tick — and never re-sums the ventures itself
// (§15.2: one source of truth). An absent total is read as the 0 it means.
//
// NOT ROUNDED, on purpose. No precision is ruled anywhere, and picking one here would be
// inventing a number; the value is derived telemetry that reaches no stored byte, so a
// consumer that wants two decimal places formats them at the point of display.
function issuanceModifier(state, guild) {
  const expected = expectedReputation(state, guild);
  if (expected === 0) return 1;
  const reputation = (guild && guild.guildReputation) || 0;
  const raw = 1 + ISSUANCE_SENSITIVITY * ((reputation - expected) / expected);
  return Math.max(ISSUANCE_FLOOR, Math.min(ISSUANCE_CEIL, raw));
}

// foundingEndowmentFor(state, guild) -> the one-time reputation a founding grants, an
// integer ≥ 0. `MEANLINE_K × systemPoints(...)` — the RP a guild is expected to have
// earned for the systems it holds, and nothing else.
//
// docs/points-and-reputation.md §2.5 (A′). WHY IT EXISTS: GP counts held systems, RP is
// earned per venture, and a just-founded guild holds its home system and has no ventures —
// its starter assets are idle inventory and score nothing. So `expectedRP` is 200 against
// an RP of 0 and the modifier pins at the FLOOR, throttling a brand-new guild to 30% fuel
// before it has had any chance to earn. This is §1.2's passive-asset offset applied at
// founding: the home system raises the bar and can never earn RP on its own, so it gets a
// one-time offset — carried on the GUILD rather than on an asset, because a founded guild
// has no venture to hold it.
//
// THE SYSTEM HALF ONLY, and that is the whole of the design's restraint. It is sized off
// `systemPoints`, NOT `guildPoints`: ventures earn their own bar (§1.2 — productive assets
// get no offset), so a founding that carries inline ventures endows only the home-system
// component and those ventures still run the normal lean-then-earn loop. Every system
// grabbed AFTER founding raises GP with no matching endowment, so sprawl still sinks a
// guild below its line and density-beats-sprawl is untouched.
//
// IT INVENTS NO NUMBER (§18 #5). `MEANLINE_K` and `W_SYS` are both already ruled, and the
// endowment is their product — so it TRACKS a retune of either instead of drifting from
// it. There is no `[FIRST-CUT]` here and no tuning row for it. ⤳ The 01-09-26 rescale is
// the proof that works: the endowment moved `150 × 12 = 1800` → `1 × 200 = 200` with NO
// edit to this function, because it was never a stored constant.
//
// ⚠ IT AUTHORS NOTHING. This is a pure SIZING function: it computes an amount and writes
// no state. The GRANT is made once, in the `foundGuild` apply (sim/actions.js), which is
// what keeps §4's seam intact — this module still only ever READS reputation, and the
// licence layer is still the only thing that MOVES it through play. It lives here rather
// than in the founding apply because the amount is a point ON the mean line, and putting
// it here means the founding apply names no constant of its own.
function foundingEndowmentFor(state, guild) {
  return MEANLINE_K * systemPoints(state, guild);
}

module.exports = {
  MEANLINE_K, ISSUANCE_SENSITIVITY, ISSUANCE_FLOOR, ISSUANCE_CEIL,
  expectedReputation, issuanceModifier, foundingEndowmentFor,
};
