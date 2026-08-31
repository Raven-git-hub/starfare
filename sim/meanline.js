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

const { guildPoints } = require('./points.js');

// MEANLINE_K — the reputation expected per Point of size.
//
// `[FIRST-CUT]` **150**, ruled in phase-1-tuning.md §"Points & Reputation" and
// CALIBRATED BY MODEL rather than guessed. It is large because the two quantities it
// bridges live on very different scales: RP rests in the THOUSANDS (the §2.3 taper parks
// an all-meeting venture just under the 1500 cap — 1494 at moderate terms, 1497 at full)
// while GP is in the TENS (12 a system, 6–8 a venture). If a rounder `k` is ever wanted,
// the doc's own note is to scale the GP weights ×10 rather than to bend this.
//
// WHAT 150 ACTUALLY CALIBRATES, and it is worth stating because the number looks
// arbitrary until you see it: at `k = 150` a system's worth of Points (12 → 1800 expected
// RP) is paid for by roughly **three ventures at rest** (3 × ~1494 = 4482 against
// 4500 expected). So "par" is about three ventures per held system, and the whole
// density-beats-sprawl shape falls out of that one relation: put three producers on a
// system and you sit on your line; hold the same three across three systems and you are
// throttled to ~0.33.
const MEANLINE_K = 150;

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

module.exports = {
  MEANLINE_K, ISSUANCE_SENSITIVITY, ISSUANCE_FLOOR, ISSUANCE_CEIL,
  expectedReputation, issuanceModifier,
};
