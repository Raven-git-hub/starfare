'use strict';

// reputation.test.js — the reputation engine (docs/points-and-reputation.md §2).
//
// SLICE 1 (31-08-26) made RP exist and move: `venture.reputation`, summed into
// `guild.guildReputation`, moved by the licence's met/breach verdict at the window
// boundary. SLICE 2 (31-08-26, §2.2's ruled arithmetic) replaced that slice's flat
// `[FIRST-CUT]` ±20/−30 placeholders with the real dynamics, and this file was rewritten
// with them:
//
//   - the MET gain is TERMS-SCALED — `REP_MEET_MAX × (0.5·commit + 0.5·equityFrac)` — the
//     deploy meter made real, so what a met cycle is worth depends on what the venture
//     actually promised. Full terms is +100 a cycle raw — reaching the +1000 tier on the
//     eleventh cycle rather than the tenth, because the taper below bites first.
//   - the BREACH drop is LINEAR and INVERSE to commitment — −10 at a full commitment,
//     toward −100 as the commitment approaches nothing. Breaking a token promise is
//     contempt; falling short of an ambitious one is forgivable.
//   - GAINS TAPER above the 800 knee toward the 1500 soft cap; DROPS DO NOT, at any
//     height. That asymmetry is the "slow to climb, fast to fall" theme, and it is what
//     makes the top of the band a hard-won, fragile buffer.
//   - RP is clamped to the band. The FLOOR is a hard clamp in the tick; the CAP is held
//     organically by the taper, which rounds a gain to zero before 1500 is reached.
//
// WHAT THIS SLICE STILL IS NOT. Reaching −500 is a PIN, not a closure: venture removal,
// licence revocation and the −300 forced-lease offer are a separate later slice and none
// of them is built. There is no GP, no mean line, no `expectedRP`, and the met gain is
// deliberately NOT window-pro-rated at this cut. No test below asserts otherwise.
//
// THE MECHANISM WORTH TESTING is the shared verdict. RP and the licence fee are moved by
// the SAME `status`, read from the SAME row, in the SAME loop (sim/tick.js), so a venture
// can never be charged as breached and credited as met. Several tests assert the fee and
// the RP together for exactly that reason — agreement is the property, not a coincidence.
//
// The fixtures are deliberately the ones licence-fee-charge.test.js already uses (same
// mine, same short window, same paced/pinned send), because this slice rides that slice's
// verdict and a second set of fixtures would be a second definition of "met".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot, SNAPSHOT_SCHEMA } = require('../snapshot.js');
const { saveState, loadOrInit } = require('../persist.js');
const { TIER_WEIGHT } = require('../points.js');
const W_T1 = TIER_WEIGHT[1];
const {
  EQUITY_CEILING,
  REP_MEET_MAX, REP_W_COMMIT, REP_W_EQUITY, REP_BREACH_MAX, REP_BREACH_MIN,
  RP_FLOOR, RP_SOFT_CAP, RP_TAPER_KNEE,
  metGain, breachPenalty, gainFactor, reputationDelta, tierFactor, signingBump, ventureTierWeight,
} = require('../licence.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const GOOD = 'titanium';
const N = 4;                                  // a short window, so a boundary is 4 ticks away

// The two terms fixtures reason about, named once. FULL terms = a full commitment AND the
// structural 49% equity ceiling — the corner the meter scores at its maximum.
const FULL_EQUITY = EQUITY_CEILING;
const GAIN_FULL_TERMS = REP_MEET_MAX;                       // 10 — tier 1, full terms
const GAIN_COMMIT_ONLY = REP_MEET_MAX * REP_W_COMMIT;       // 5 — committed all, offered nothing
// What a FULL-commitment breach actually costs, at tier 1: `REP_BREACH_MIN` ROUNDED. The
// constant is a sanctioned float (2.5) since §2.6 lifted the breach floor to a quarter of
// MAX, and `breachPenalty` rounds — so fixtures name the landed integer, not the constant.
const DROP_FULL_COMMIT = Math.round(REP_BREACH_MIN);        // 3

const mine = (id, { systemId = SYS, productionRate = 10, equityPct } = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: GOOD, productionRate,
  ...(equityPct === undefined ? {} : { equityPct }),
});
// ── THE SIGNING BUMP (§2.6, ruled + BUILT 01-09-26, slice 2) ────────────────────────
// Every licensed venture below now OPENS on a bump rather than at 0 — `2 × commit ×
// W_TIER` minted by `applyForLicence` itself, so signing is the first thing that moves a
// venture's reputation and the boundary verdicts move it FROM there. That is the whole
// point of the slice, so it is named once here and every absolute figure below is written
// as `bump + what the cycles did`, which keeps each test about the thing it was written
// for. Read from the engine, never typed, so these track the ruling.
//
// The fixtures are all TIER-1 mines, so the weight is 100 and the bump is `200 × commit`.
const bumpAt = (commit) => signingBump({ ...mine('bump-probe'), licence: { committedOutputPct: commit } });
const BUMP_FULL_COMMIT = bumpAt(1);        // 200 — the `licenceAll` default
const BUMP_HALF_COMMIT = bumpAt(0.5);      // 100 — exactly the mine's own GP: on its line


function fixture(ventures) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}

const guild = (s) => s.guilds[0];
const ven = (s, id) => guild(s).ventures.find((v) => v.id === id);
const rp = (s, id) => ven(s, id).reputation;

// A bare venture-shaped object for the PURE functions, so their arithmetic can be tested
// without standing a whole galaxy up. The engine tests below use the real tick.
// ⤳ 01-09-26: this stub now names a `resourceType`. Since the rescale (§2.6) `metGain` and
// `breachPenalty` are TIER-scaled, so they read the venture's produced good — a stub with
// no output would (rightly) halt on an unknown tier rather than quietly earning at the
// tier-1 rate. `GOOD` is titanium, so every `terms(...)` below is a TIER-1 venture and its
// `tierFactor` is exactly 1; the tier-2 cases have their own tests further down.
const terms = (committedOutputPct, equityPct = 0) => ({
  id: 'terms', equityPct, resourceType: GOOD, licence: { committedOutputPct },
});

// Licence at tick 0, before any window opens, so every window is FULL (`windowFraction`
// 1) and no pro-rate is in play — the same convention licence-fee-charge.test.js uses.
const licenceAll = (s, ids, committedOutputPct = 1) => intake(s, ids.map((id) =>
  createApplyForLicenceAction({ guildId: 'g1', ventureId: id, committedOutputPct, windowDays: 7 }))).state;

// Pin the Syndicate send, so the pile at the boundary is a fact of the fixture rather than
// whatever the paced default converges on. `value: 0` sends NOTHING, which breaches any
// positive commitment — the only way to breach a SMALL one, whose target the paced
// default would otherwise comfortably fill.
const send = (s, value, systemId = SYS) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId, goods: { [GOOD]: { syndicate: { mode: 'absolute', value } } },
})]).state;
const starve = (s, systemId = SYS) => send(s, 0, systemId);

// Put a venture AT a reputation the engine would have taken many cycles to reach, keeping
// the guild total exact so `checkGuildReputationSum` stays green. Standing in for those
// cycles, not bypassing a rule: every test using this then drives the REAL tick from
// there and asserts what the tick does.
function atRP(s, id, value) {
  ven(s, id).reputation = value;
  guild(s).guildReputation = guild(s).ventures.reduce((n, v) => n + (v.reputation || 0), 0);
  return s;
}

const runToBoundary = (s) => {
  do { s = tick(s); } while (s.tick % N !== 0);
  return s;
};

// The guild sum must equal Σ its ventures after EVERY tick this file runs — the property
// `checkGuildReputationSum` exists for. Asserted by hand as well as through the invariant
// so a failure names the two numbers rather than a rule id.
function assertSumHolds(s, where) {
  for (const g of s.guilds) {
    const summed = (g.ventures || []).reduce((n, v) => n + (v.reputation || 0), 0);
    assert.equal(g.guildReputation, summed, `${where}: guild ${g.id}'s total drifted from its ventures`);
  }
  assert.deepEqual(checkInvariants(s, s.tick), [], `${where}: an invariant tripped`);
}

// --- 1. the ruled constants ------------------------------------------------------

test('the slice-2 constants are the ruled [FIRST-CUT] numbers, and the weights sum to 1', () => {
  // Pinned so a silent retune cannot pass unnoticed; phase-1-tuning.md is where a
  // deliberate one is recorded, in the same commit as the code.
  // ⤳ RESCALED 01-09-26 (§2.6): MEET_MAX and BREACH_MAX ÷10 with the RP scale, and
  // BREACH_MIN lifted from 10% of MAX to 25% of it (so 10 → 2.5, not 10 → 1). The BAND is
  // deliberately UNCHANGED — §2.6 defers its own rescale to the next ruling.
  assert.equal(REP_MEET_MAX, 10);
  assert.equal(REP_BREACH_MAX, 10);
  assert.equal(REP_BREACH_MIN, 2.5);
  assert.equal(REP_BREACH_MIN / REP_BREACH_MAX, 0.25, 'the floor is a QUARTER of the max, lifted from a tenth');
  assert.equal(RP_FLOOR, -500);
  assert.equal(RP_SOFT_CAP, 1500);
  assert.equal(RP_TAPER_KNEE, 800);
  // The weights summing to exactly 1 is what makes full terms at tier 1 score
  // REP_MEET_MAX exactly — the venture's whole 100-point bar in ten met cycles (§2.6's
  // break-even), so the licence layer's tiers fall out of the meter instead of being a
  // second number.
  assert.equal(REP_W_COMMIT + REP_W_EQUITY, 1);
  assert.equal(metGain(terms(1, FULL_EQUITY)), REP_MEET_MAX, 'full terms at tier 1 scores the maximum exactly');
});

// --- 2. the met gain: terms-scaled -----------------------------------------------

test('metGain is the deploy meter: REP_MEET_MAX × (0.5·commit + 0.5·equityFrac)', () => {
  assert.equal(metGain(terms(1, FULL_EQUITY)), 10, 'commit everything, offer the ceiling');
  assert.equal(metGain(terms(1, 0)), 5, 'commit everything, offer nothing — half the meter');
  assert.equal(metGain(terms(0, FULL_EQUITY)), 5, 'commit nothing, offer the ceiling — the other half');
  assert.equal(metGain(terms(0.5, FULL_EQUITY / 2)), 5, 'half and half');
  assert.equal(metGain(terms(0.5, 0)), 3, 'a quarter of the meter is 2.5, rounded to 3');
  assert.equal(metGain(terms(0.25, FULL_EQUITY)), Math.round(REP_MEET_MAX * (0.5 * 0.25 + 0.5)),
    'the two axes are independent — and the gain is a whole number (§15.2), so 6.25 rounds to 6');
  assert.equal(metGain(terms(0.25, FULL_EQUITY)), 6, 'stated outright, so the rounding is not implied by the formula it is testing');
});

test('YOU DO NOT EARN RP FOR OWNING: zero terms met scores exactly zero', () => {
  // §2's headline rule, and it needs no special case — it falls out of the formula. A 0%
  // licence is always `met` (it owed zero units), so without this the engine would pay a
  // venture for promising nothing, forever, and RP would measure size instead of
  // contribution.
  assert.equal(metGain(terms(0, 0)), 0);
});

test('the met gain rises MONOTONICALLY with each term', () => {
  // ⤳ 01-09-26: the steps are checked NON-strictly now. At the rescaled REP_MEET_MAX = 10
  // the meter's whole range is ten integers wide, so two nearby terms can round to the
  // same gain — 0.1 and 0.25 equity both land on 1. That is the rescale's real cost and
  // it is worth stating rather than papering over: the meter is coarser. It must still
  // never go DOWN as a term goes up, which is what §2.2's shape actually promises, and it
  // must still span the full range end to end.
  let previous = -1;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const g = metGain(terms(c, 0));
    assert.ok(g >= previous, `commitment ${c} must be worth at least the step below`);
    previous = g;
  }
  assert.ok(metGain(terms(1, 0)) > metGain(terms(0, 0)), 'and end to end it really does rise');
  previous = -1;
  for (const o of [0, 0.1, 0.25, 0.4, FULL_EQUITY]) {
    const g = metGain(terms(0, o));
    assert.ok(g >= previous, `equity ${o} must be worth at least the step below`);
    previous = g;
  }
  assert.ok(metGain(terms(0, FULL_EQUITY)) > metGain(terms(0, 0)), 'and end to end it really does rise');
});

// --- 3. the breach drop: linear, inverse to commitment ---------------------------

test('breachPenalty is linear and INVERSE to commitment — cheap when you promised a lot', () => {
  // ⤳ RESCALED 01-09-26. The full-commitment end is −3 (2.5 rounded), not −1: §2.6 lifted
  // REP_BREACH_MIN to a QUARTER of MAX so the sign-at-100%-then-breach tail is not free.
  assert.equal(breachPenalty(terms(1, 0)), -3, 'a full commitment breached costs only −3');
  assert.equal(breachPenalty(terms(0, 0)), -REP_BREACH_MAX, 'the c→0 endpoint is −10');
  assert.equal(breachPenalty(terms(0.5, 0)), -6, 'linear: the midpoint (6.25) is the midpoint');
  assert.equal(breachPenalty(terms(0.25, 0)), -8);
  // Breaking a token promise is contempt; falling short of an ambitious one is forgivable.
  assert.ok(breachPenalty(terms(0.1, 0)) < breachPenalty(terms(0.9, 0)),
    'a small commitment breached must hurt MORE than a large one');
});

test('the breach drop ignores equity — §2.2 scales it by commitment alone', () => {
  assert.equal(breachPenalty(terms(0.5, 0)), breachPenalty(terms(0.5, FULL_EQUITY)));
});

test('the −100 endpoint is a LIMIT, never paid: a 0% licence cannot breach', () => {
  // §5's 0% commitment floor: a 0% licence owes zero units, so it is `met` every window.
  // The formula's c→0 end is therefore approached and never reached through play — worth
  // pinning, because a future change that let a 0% licence breach would quietly make the
  // harshest penalty in the model the one paid for promising nothing.
  let s = starve(licenceAll(fixture([mine('m')]), ['m'], 0));
  s = runToBoundary(s);
  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'met', 'owed nothing, delivered nothing, met');
  // And it earns NOTHING for it (§2: you do not earn RP for owning). The verdict is real
  // — the fee is charged — but the gain is zero, so no key is minted: a 0%-floor licence
  // adds not one byte of reputation to the galaxy, however long it runs.
  assert.equal(ven(s, 'm').reputation, undefined, 'a zero-delta verdict mints nothing');
  assert.equal(guild(s).guildReputation, 0);
  for (let w = 0; w < 3; w += 1) s = runToBoundary(s);
  assert.equal(ven(s, 'm').reputation, undefined, 'and still nothing, four windows in');
  assert.equal(canonicalStringify(s).includes('"reputation"'), false,
    'the string "reputation" appears nowhere in a 0%-licensed run’s serialized state');
  assertSumHolds(s, 'a 0% licence');
});

// --- 3b. the TIER factor (ruled 01-09-26, §2.6) -----------------------------------

// A tier-2 stub, the refining counterpart of `terms` above. It names a `recipeId`, so
// `producedGoodFor` resolves to a PROCESSED good and `tierOf` reads 2.
const tier2Terms = (committedOutputPct, equityPct = 0) => ({
  id: 'terms2', equityPct, recipeId: 'titanium_alloy', licence: { committedOutputPct },
});

test('tierFactor is the venture\'s GP weight over the tier-1 weight — 1 at T1, 1.5 at T2', () => {
  assert.equal(tierFactor(terms(1, 0)), 1, 'a mine is the unit');
  assert.equal(tierFactor(tier2Terms(1, 0)), 1.5, 'a refinery earns half again as much');
  // SOURCED FROM `sim/points.js`, not from a literal 100, so it survives a retune of the
  // absolute GP scale. This is the assertion that would go red if someone re-hardcoded it.
  assert.equal(tierFactor(tier2Terms(1, 0)), TIER_WEIGHT[2] / TIER_WEIGHT[1]);
});

test('a HIGHER TIER earns and loses proportionally more — the reward for climbing the tree', () => {
  // §2.6: the tier scales BOTH directions, so the stake rises with the tier rather than
  // the bar. Full terms: +10 at tier 1, +15 at tier 2.
  assert.equal(metGain(terms(1, FULL_EQUITY)), 10);
  assert.equal(metGain(tier2Terms(1, FULL_EQUITY)), 15);
  // …and the breach scales the same way: −3 at tier 1, −4 at tier 2 (2.5 × 1.5 = 3.75).
  assert.equal(breachPenalty(terms(1, 0)), -3);
  assert.equal(breachPenalty(tier2Terms(1, 0)), -4);
});

test('EVERY TIER BREAKS EVEN IN THE SAME TEN CYCLES — that is what the factor buys', () => {
  // The whole point of the ruling (§2.6). A venture's BAR is its GP weight; its earn rate
  // is `REP_MEET_MAX × tierFactor`. Both scale by the same factor, so the ratio — the
  // cycles to break even — is identical at every tier. A higher tier is a bigger deal, not
  // a longer grind.
  for (const v of [terms(1, FULL_EQUITY), tier2Terms(1, FULL_EQUITY)]) {
    const bar = TIER_WEIGHT[tierFactor(v) === 1 ? 1 : 2];
    assert.equal(bar / metGain(v), 10, 'ten full-terms met cycles pay for the venture, at any tier');
  }
});

test('an UNWEIGHTED tier HALTS rather than quietly earning at the tier-1 rate', () => {
  // The same stop `guildPoints` makes (§18 / §15.5). A tier-3 venture scoring the tier-1
  // earn rate would be the quietest possible bug — it would look like it was working.
  const t3 = { id: 'x', equityPct: 0, resourceType: 'deuterium_fuel', licence: { committedOutputPct: 1 } };
  assert.throws(() => metGain(t3), /no ruled GP weight/);
  assert.throws(() => breachPenalty(t3), /no ruled GP weight/);
  // And a venture that produces NOTHING at all halts too: RP only moves for a venture the
  // fee loop already judged, so one arriving here with no output is a contradiction.
  assert.throws(() => metGain({ id: 'y', licence: { committedOutputPct: 1 } }), /no ruled GP weight/);
});

// --- 3c. the SIGNING BUMP (ruled + BUILT 01-09-26, §2.6 — slice 2 of the rescale) ---

test('signingBump is 2 x commit x the venture\'s OWN GP weight — 0 / 1x / 2x its GP', () => {
  // The three cases §2.6 names, at tier 1 (weight 100).
  assert.equal(signingBump(terms(0, 0)), 0, '0% commit: adds GP, mints nothing — below its line');
  assert.equal(signingBump(terms(0.5, 0)), 100, '50%: exactly its own GP — bar-neutral, ON its line');
  assert.equal(signingBump(terms(1, 0)), 200, '100%: twice its GP — launched ABOVE its line');
  assert.equal(signingBump(terms(0.5, 0)), W_T1, 'the 50% case IS the tier-1 weight, stated against the constant');
  // Linear between, and an integer at every step (§15.2).
  for (const c of [0, 0.13, 0.25, 0.5, 0.77, 1]) {
    const b = signingBump(terms(c, 0));
    assert.equal(b, Math.round(2 * c * W_T1), `commit ${c}`);
    assert.ok(Number.isInteger(b) && b >= 0);
  }
});

test('the bump scales with TIER, off the ABSOLUTE weight — not the tierFactor ratio', () => {
  // §2.6 sizes the bump against the venture's OWN GP — the bar it just added to its guild
  // — so a refinery's bump is 150-based, not 100-based. This is the one place the RP model
  // wants the weight itself rather than the 1 / 1.5 / 3 / 5 ratio the per-cycle rate uses.
  assert.equal(signingBump(tier2Terms(1, 0)), 300, 'a T2 refinery at 100%: twice its 150 GP');
  assert.equal(signingBump(tier2Terms(0.5, 0)), 150, 'and at 50% exactly its own GP — bar-neutral at any tier');
  assert.equal(signingBump(tier2Terms(0.5, 0)), TIER_WEIGHT[2]);
  // BAR-NEUTRAL AT 50% IS TIER-INVARIANT, which is the property that matters: whatever a
  // venture is worth in GP, signing the Syndicate's expected deal covers exactly its own bar.
  for (const v of [terms(0.5, 0), tier2Terms(0.5, 0)]) {
    assert.equal(signingBump(v), ventureTierWeight(v), 'a 50% signing covers its own bar, at every tier');
  }
});

test('the bump ignores EQUITY — commitment alone buys an opening position', () => {
  // The one place this parts company with `metGain`, and it is deliberate (§2.6 sizes the
  // bump off `committedOutputPct` alone). Equity buys a share of the per-cycle EARN; if it
  // bought the bump too, a guild could buy its way onto its line by giving away shares
  // while promising no output at all.
  assert.equal(signingBump(terms(0.5, 0)), signingBump(terms(0.5, FULL_EQUITY)));
  assert.equal(signingBump(terms(0, FULL_EQUITY)), 0, 'all the equity in the world buys no bump');
  // …while the same two terms DO move the per-cycle gain, so this is a real difference and
  // not two functions that happen to agree.
  assert.notEqual(metGain(terms(0.5, 0)), metGain(terms(0.5, FULL_EQUITY)));
});

test('the bump refuses a venture with no licence, and halts on an unweighted tier', () => {
  // It reads `repTerms`, so an unlicensed venture throws for the same reason `metGain`
  // does: a SIGNING bump minted for a contract that does not exist would be nonsense.
  assert.throws(() => signingBump({ id: 'x', resourceType: GOOD }), /no licence/);
  // And an unweighted tier halts rather than quietly minting at the tier-1 rate.
  assert.throws(
    () => signingBump({ id: 'x', resourceType: 'deuterium_fuel', licence: { committedOutputPct: 1 } }),
    /no ruled GP weight/,
  );
});

test('signing MINTS the bump once, and re-applying is refused so it cannot be farmed', () => {
  // The mint happens in `applyForLicence` (sim/actions.js), not in the tick — so it is
  // there the moment the action lands, before any tick runs.
  const s = licenceAll(fixture([mine('m')]), ['m']);
  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT, 'minted at signing, before the first tick');
  assert.equal(guild(s).guildReputation, BUMP_FULL_COMMIT, 'and the guild total moved by the same amount');
  assertSumHolds(s, 'immediately after signing');

  // A SECOND application on the same venture is refused, so there is no re-bump path and
  // the bump cannot be farmed by re-signing. (Renegotiation is #64 and unbuilt; whether it
  // re-bumps is deliberately NOT ruled here.)
  const again = intake(s, [createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'm', committedOutputPct: 1, windowDays: 7,
  })]);
  assert.equal(again.results[0].accepted, false, 'a second application is refused…');
  assert.match(again.results[0].reason, /already licensed/, '…as an unbuilt RENEGOTIATION, by name');
  assert.equal(rp(again.state, 'm'), BUMP_FULL_COMMIT, 'and not one further point was minted');
  assertSumHolds(again.state, 'after a refused re-application');
});

// --- 4. the taper -----------------------------------------------------------------

test('gainFactor tapers GAINS between the knee and the cap, and only there', () => {
  assert.equal(gainFactor(0), 1, 'full strength at rest');
  assert.equal(gainFactor(RP_TAPER_KNEE), 1, 'full strength right up to the knee');
  assert.equal(gainFactor(1150), 0.5, 'half way between knee and cap');
  assert.equal(gainFactor(RP_SOFT_CAP), 0, 'nothing lands at the cap');
  assert.equal(gainFactor(RP_SOFT_CAP + 500), 0, 'clamped, never negative');
  // A recovering venture climbs at FULL strength — the taper bites only above the knee —
  // so a redemption arc out of the closure zone is achievable (§2.3).
  assert.equal(gainFactor(-499), 1, 'a venture at the floor recovers at full strength');
  assert.equal(gainFactor(RP_FLOOR), 1);
});

test('reputationDelta refuses a non-verdict, and refuses a venture with no licence', () => {
  assert.equal(reputationDelta('met', terms(1, FULL_EQUITY)), 10, 'met returns the gain');
  assert.equal(reputationDelta('breach', terms(1, 0)), -3, 'breach returns the (negative) drop');
  // RP moves only at a boundary. A silent 0 would be a reputation that simply never
  // moved, with nothing going red (§15.5).
  assert.throws(() => reputationDelta('accruing', terms(1, 0)), /boundary verdict/);
  assert.throws(() => reputationDelta(undefined, terms(1, 0)), /boundary verdict/);
  // The gain is scaled by LICENCE TERMS, so a venture without a licence has no terms to
  // scale by — reaching here would mean RP moved for a contract that does not exist.
  assert.throws(() => reputationDelta('met', { id: 'x' }), /no licence/);
});

// --- 5. the engine: what a real boundary actually does ---------------------------

test('a FULL-TERMS met gains exactly +10 at the boundary, below the knee', () => {
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  // ⤳ 01-09-26 (slice 2): signing already minted the bump, so the venture does not open at
  // 0 any more. The GAIN is what this test is about, so it is measured as a DELTA across
  // the boundary — the figure that did not change — with the opening bump pinned beside it
  // so the absolute is still stated outright.
  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT, 'it opens on its signing bump, not at zero');
  const before = rp(s, 'm');
  s = runToBoundary(s);

  assert.equal(s.tick, N);
  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'met',
    'the fixture really did meet — the RP claim is about a verdict, not a hope');
  assert.equal(rp(s, 'm') - before, GAIN_FULL_TERMS, 'the boundary added exactly the full-terms gain');
  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT + GAIN_FULL_TERMS);
  assert.equal(guild(s).guildReputation, BUMP_FULL_COMMIT + GAIN_FULL_TERMS);
  assertSumHolds(s, 'a full-terms met');
});

test('a PARTIAL-TERMS met gains the weighted value, not the maximum', () => {
  // Committed everything, offered no equity: half the meter.
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);
  assert.equal(rp(s, 'm') - BUMP_FULL_COMMIT, GAIN_COMMIT_ONLY, 'the GAIN is half the meter…');
  assert.equal(rp(s, 'm') - BUMP_FULL_COMMIT, metGain(ven(s, 'm')), 'and it is exactly what metGain says for these terms');

  // Committed half, offered half the ceiling: the same 5 by a different route — proof
  // the two axes really are weighted, not that one of them is being ignored.
  //
  // ⚠ THE BUMPS ARE NOT THE SAME, and that is the slice-2 lesson worth pinning here: the
  // gain is scaled by commitment AND equity, the signing bump by COMMITMENT ALONE. So a
  // half-commit venture opens on half the bump (100, not 200) while earning the identical
  // 5 a cycle. Equity buys per-cycle earning; it does not buy an opening position.
  let t = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY / 2 })]), ['m'], 0.5);
  assert.equal(rp(t, 'm'), BUMP_HALF_COMMIT, 'half the commitment, half the bump');
  assert.notEqual(BUMP_HALF_COMMIT, BUMP_FULL_COMMIT);
  t = runToBoundary(t);
  assert.equal(rp(t, 'm') - BUMP_HALF_COMMIT, 5, 'the same 5 a cycle by a different route');
  assertSumHolds(s, 'partial terms');
  assertSumHolds(t, 'partial terms, other route');
});

test('a BREACH at 100% commitment costs only −3; at a small commitment it costs near −10', () => {
  let big = starve(licenceAll(fixture([mine('m')]), ['m'], 1));
  big = runToBoundary(big);
  assert.equal(guild(big).lastLicenceFee.ventures.m.status, 'breach');
  // ⤳ 01-09-26: −3, the ROUNDED −REP_BREACH_MIN. The constant is a float (2.5) since the
  // breach floor was lifted to a quarter of MAX, and the rounding is what keeps the RP
  // that lands an integer — so this is stated as the landed figure, not as the constant.
  // ⤳ 01-09-26 (slice 2): measured as a DELTA off each venture's own signing bump, because
  // the two fixtures now open at different heights — the big committer at 200, the token
  // one at 20. The DROP is what this test is about and neither drop moved.
  const bigDrop = rp(big, 'm') - BUMP_FULL_COMMIT;
  assert.equal(bigDrop, -Math.round(REP_BREACH_MIN), 'the ambitious breacher is forgiven');
  assert.equal(bigDrop, -3);

  let small = starve(licenceAll(fixture([mine('m')]), ['m'], 0.1));
  small = runToBoundary(small);
  assert.equal(guild(small).lastLicenceFee.ventures.m.status, 'breach');
  const smallDrop = rp(small, 'm') - bumpAt(0.1);
  assert.equal(smallDrop, -9, 'the token promise broken is near the −10 endpoint');
  assert.ok(smallDrop < bigDrop, 'and the small commitment is the one that hurts');
  // AND THE BUMP COMPOUNDS THE LESSON RATHER THAN SOFTENING IT: the token committer opened
  // 180 RP lower AND falls further per breach. Promise nothing, start behind, stay behind.
  assert.ok(rp(small, 'm') < rp(big, 'm'), 'in absolute standing too, not just in the drop');
  assertSumHolds(big, 'big commitment breached');
  assertSumHolds(small, 'small commitment breached');
});

test('the fee and the reputation are moved by ONE verdict — they can never disagree', () => {
  // The mechanism claim, made mechanical: across four boundaries of a breaching run, the
  // venture's fee row and its RP movement are read back together. If a future refactor
  // recomputed the verdict for either consumer, one of these pairs would come apart.
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  // ⤳ 01-09-26 (slice 2): the run starts from the signing bump, not from 0. Every step is
  // still a pure DELTA check, so the mechanism claim is untouched.
  let previous = BUMP_FULL_COMMIT;
  for (let w = 0; w < 4; w += 1) {
    s = runToBoundary(s);
    const { status } = guild(s).lastLicenceFee.ventures.m;
    const expected = reputationDelta(status, ven(s, 'm'));
    assert.equal(rp(s, 'm') - previous, expected,
      `window ${w + 1}: the RP delta must be the delta OF the verdict the fee was charged on`);
    previous = rp(s, 'm');
  }
});

// --- 6. the taper, through the engine, and the organic cap -----------------------

test('a met NEAR THE TOP gains a tapered amount — not the full 10', () => {
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  s = atRP(s, 'm', 1490);
  const before = rp(s, 'm');
  s = runToBoundary(s);

  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'met', 'it really did meet, so the gain is tapered — not withheld');
  const gained = rp(s, 'm') - before;
  assert.equal(gained, Math.round(GAIN_FULL_TERMS * gainFactor(before)));
  assert.equal(gained, 0, 'at 1490 a full-terms met now rounds away entirely — the taper has swallowed it');
  // ⤳ 01-09-26: pre-rescale this landed a single digit out of 100. The band was NOT
  // rescaled with the earn rate (§2.6 defers it), so the whole 10-point gain now rounds to
  // zero this high up. The property under test — a gain near the cap is taper-shrunk, not
  // withheld — still holds, and it is checked at a height where it is still visible.
  const midBefore = 1000;
  let mid = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  mid = runToBoundary(atRP(mid, 'm', midBefore));
  const midGained = rp(mid, 'm') - midBefore;
  assert.ok(midGained > 0 && midGained < GAIN_FULL_TERMS,
    `above the knee the gain is shrunk but still lands, got ${midGained}`);
  assert.equal(midGained, Math.round(GAIN_FULL_TERMS * gainFactor(midBefore)));
  assertSumHolds(s, 'a tapered gain');
});

test('the same terms gain FULL strength below the knee and taper above it', () => {
  // The knee is a real boundary in behaviour, not just in arithmetic: one venture, two
  // starting heights, same licence.
  const run = (start) => {
    let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
    s = atRP(s, 'm', start);
    return runToBoundary(s).guilds[0].ventures[0].reputation - start;
  };
  assert.equal(run(0), GAIN_FULL_TERMS, 'at rest: full strength');
  assert.equal(run(RP_TAPER_KNEE), GAIN_FULL_TERMS, 'right at the knee: still full strength');
  assert.ok(run(1150) < GAIN_FULL_TERMS, 'above the knee: tapered');
  assert.equal(run(1150), Math.round(GAIN_FULL_TERMS * 0.5), 'and tapered by exactly the ruled factor');
  assert.equal(run(1150), 5, 'half of 10, stated outright');
});

test('DROPS ARE NEVER TAPERED — a breach high in the band costs full price', () => {
  // "Slow to climb, fast to fall" (§2.3), and this is the half that is easy to lose: the
  // taper scales GAINS only, so a venture sitting near the cap — where a met cycle is
  // worth almost nothing — still pays the whole drop when it breaches. Tapering the drop
  // as well would turn a hard-won buffer into a safe one and delete the theme, and it is
  // the one rule here that no other assertion in this file would notice being broken.
  const HIGH = 1400;
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  s = atRP(s, 'm', HIGH);
  s = runToBoundary(s);

  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'breach');
  const raw = breachPenalty(ven(s, 'm'));
  assert.equal(rp(s, 'm'), HIGH + raw, 'the FULL drop landed');
  assert.notEqual(rp(s, 'm'), HIGH + Math.round(raw * gainFactor(HIGH)),
    'and it is emphatically NOT the tapered drop — the two really are different numbers here');
  assertSumHolds(s, 'a breach near the cap');

  // THE ASYMMETRY ITSELF, measured at one height: the gain is discounted for standing
  // high, the drop is not discounted at all. That is the property — not that the drop is
  // numerically bigger, which depends on the terms (a full commitment's −10 is
  // deliberately lenient, and at 1400 a full-terms gain of 14 still beats it).
  let up = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  up = atRP(up, 'm', HIGH);
  const gained = runToBoundary(up).guilds[0].ventures[0].reputation - HIGH;
  assert.ok(gained < GAIN_FULL_TERMS * 0.2,
    `at ${HIGH} a full-terms gain keeps under a fifth of its value (${gained} of ${GAIN_FULL_TERMS})`);
  assert.equal(rp(s, 'm') - HIGH, raw, 'while the drop keeps ALL of its value at the same height');

  // And they do cross, once high enough: above ~1434 even the most forgiving breach
  // outruns the best gain the model can produce.
  let top = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  top = atRP(top, 'm', 1450);
  const gainedAtTop = runToBoundary(top).guilds[0].ventures[0].reputation - 1450;
  assert.ok(gainedAtTop < Math.abs(raw),
    `at 1450 the best possible gain (${gainedAtTop}) is finally smaller than the cheapest drop (${Math.abs(raw)})`);
});

test('RP APPROACHES the soft cap and never reaches it — no hard clamp needed at the top', () => {
  // The organic cap (§2.3). Driven with the largest gain the model can produce, so this
  // is the worst case: if anything can pass 1500, this can.
  //
  // ⤳ 01-09-26: started from 1400 rather than 1490, and run for longer. The band was NOT
  // rescaled with the earn rate (§2.6 defers it), so the tapered gain now rounds away
  // sooner and lower — a run begun at 1490 would not move at all and would prove nothing.
  // The property is unchanged: the taper alone holds the top, with no clamp.
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  s = atRP(s, 'm', 1400);
  for (let w = 0; w < 70; w += 1) {
    s = runToBoundary(s);
    assert.ok(rp(s, 'm') < RP_SOFT_CAP, `boundary ${w + 1}: RP must stay strictly below the cap, got ${rp(s, 'm')}`);
  }
  assert.equal(rp(s, 'm'), 1466, 'it settles at 1466, where the tapered gain first rounds to zero');

  // Settled, not stalled by luck: another twenty met boundaries move it not one point.
  const settled = rp(s, 'm');
  for (let w = 0; w < 20; w += 1) s = runToBoundary(s);
  assert.equal(rp(s, 'm'), settled, 'the asymptote holds — every further met gain rounds to 0');
  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'met', 'and it was still MEETING the whole time');
  assertSumHolds(s, 'at the asymptote');
});

// --- 7. the floor: a hard clamp, and the guild sum that must follow it ------------

test('a breach that would UNDERSHOOT the floor pins at −500, and the guild sum moves by the ACTUAL change', () => {
  // ⤳ 01-09-26: started at −498 rather than −495. A full-commitment breach costs −3 since
  // the rescale, so −495 no longer undershoots the floor and the test would have stopped
  // exercising the clamp it exists for.
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  s = atRP(s, 'm', -498);
  assert.equal(guild(s).guildReputation, -498, 'the fixture starts consistent');

  s = runToBoundary(s);
  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'breach');
  assert.equal(breachPenalty(ven(s, 'm')), -3, 'the raw drop would have taken it to −501');
  assert.equal(rp(s, 'm'), RP_FLOOR, 'but it pins at the floor');
  // THE LINE THE CLAMP MAKES LOAD-BEARING: the guild moved by −2 (the actual change), not
  // by the −3 the venture was charged. Adding the raw delta here would drift the total
  // below the sum of its ventures — silently, but for this assertion and the invariant.
  assert.equal(guild(s).guildReputation, RP_FLOOR, 'the guild total followed the CLAMPED change, not the raw one');
  assertSumHolds(s, 'a clamped breach');
});

test('a venture ALREADY at the floor absorbs further breaches without moving anything', () => {
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  s = atRP(s, 'm', RP_FLOOR);
  for (let w = 0; w < 3; w += 1) {
    s = runToBoundary(s);
    assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'breach', 'still being judged, and still failing');
    assert.equal(rp(s, 'm'), RP_FLOOR, `boundary ${w + 1}: pinned`);
    assertSumHolds(s, `pinned at the floor, boundary ${w + 1}`);
  }
  // ⚠ AND IT IS STILL RUNNING. Reaching the floor is a pin, not a closure — the venture
  // keeps producing, keeps being licensed and keeps being charged. Venture removal and
  // licence revocation are a LATER slice, and this pins that they are not built.
  assert.ok(ven(s, 'm').licence, 'the licence is not revoked');
  assert.ok(guild(s).lastLicenceFee.ventures.m.owed > 0, 'and the fee is still being charged');
});

test('a venture at the floor CLIMBS BACK at full strength — the redemption arc is real', () => {
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  s = atRP(s, 'm', RP_FLOOR);
  s = runToBoundary(s);
  assert.equal(rp(s, 'm'), RP_FLOOR + GAIN_FULL_TERMS, 'no taper down here — the full gain lands');
  assertSumHolds(s, 'recovering from the floor');
});

// --- 8. it moves ONCE, and only on a boundary ------------------------------------

test('a NON-boundary tick moves no reputation at all', () => {
  // ⤳ RESTATED 01-09-26 (slice 2), and the restatement is the point rather than a repair.
  // This test used to assert the key did not EXIST until the first boundary — "minted by
  // the first verdict that moves it". Signing now moves it first, so the field's lifecycle
  // is "minted by the first thing that moves it, which is normally SIGNING". What the test
  // was really guarding is unchanged and is what it checks now: RP moves ONLY at a
  // boundary, and a mid-window tick moves nothing.
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT, 'signing minted the bump, before any tick ran');

  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(s.tick % N === 0, false, 'this test is only meaningful off a boundary');
    assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT,
      `tick ${s.tick}: no verdict has been reached, so nothing has moved since signing`);
    assert.equal(guild(s).guildReputation, BUMP_FULL_COMMIT);
  }

  s = tick(s);
  assert.equal(s.tick, N);
  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT + GAIN_FULL_TERMS, 'the boundary is where it moves');
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT + GAIN_FULL_TERMS,
      `tick ${s.tick}: a mid-window tick must move nothing`);
  }
  assertSumHolds(s, 'mid-window');
});

test('ONCE PER BOUNDARY: four windows of a met licence is exactly four gains', () => {
  let s = licenceAll(fixture([mine('m', { equityPct: FULL_EQUITY })]), ['m']);
  for (let w = 1; w <= 4; w += 1) {
    s = runToBoundary(s);
    assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT + w * GAIN_FULL_TERMS, `after ${w} boundaries`);
    assertSumHolds(s, `boundary ${w}`);
  }
  // WHAT TEN MET CYCLES EARN, AND WHERE THE BUMP LEAVES A VENTURE STANDING.
  //
  // §2.6's rescale calibrated the EARN RATE against the venture's OWN BAR: a tier-1 mine
  // is worth 100 GP, a full-terms met cycle earns +10, so ten met cycles earn the venture's
  // whole bar — the break-even the ruling names, and every tier breaks even in the same ten
  // because `tierFactor` scales both. That is a claim about the RATE, so it is pinned as a
  // delta, and slice 2's bump did not touch it.
  for (let w = 5; w <= 10; w += 1) s = runToBoundary(s);
  assert.equal(rp(s, 'm') - BUMP_FULL_COMMIT, 10 * GAIN_FULL_TERMS, 'ten full-terms cycles EARN');
  assert.equal(rp(s, 'm') - BUMP_FULL_COMMIT, W_T1, '…exactly the mine\'s 100-point bar — break-even in ten');
  // ⤳ AND WHAT SLICE 2 CHANGED: this venture signed at 100%, so it was already TWO bars up
  // before its first cycle. Ten cycles of earning take it to three. "Break-even in ten" is
  // now the rate at which a venture climbs PAST the line it already opened on, not the
  // climb up to it — which is the whole point of the bump.
  assert.equal(BUMP_FULL_COMMIT, 2 * W_T1, 'a 100% signing opens two bars up');
  assert.equal(rp(s, 'm'), 3 * W_T1);

  // ⚠ THE BAND, HOWEVER, WAS NOT RESCALED — §2.6 defers it, deliberately, and this is what
  // that deferral costs in play. At +10 a cycle the 800 knee is EIGHTY full-strength cycles
  // of earning away (it used to be eight), and the +1000 dividend-max tier a hundred-odd.
  // The signing bump takes the edge off — a 100%-commit venture starts 200 up, so it
  // reaches the knee on cycle 60 and the dividend tier on 84 rather than 80 and 104 — but
  // it does not close the gap: the licence layer's tiers still sit an order of magnitude
  // above the meter that is supposed to reach them. Pinned as a TRIPWIRE on the known gap,
  // not as an endorsement: the band's own ruling (and the global-vs-per-tier sub-choice the
  // 1 : 1.5 : 3 : 5 spread forces) is the next pass, and it should move these numbers.
  assert.equal(RP_TAPER_KNEE / GAIN_FULL_TERMS, 80, 'the knee is 80 met cycles of EARNING away, not 8');
  for (let w = 11; w <= 60; w += 1) s = runToBoundary(s);
  assert.equal(rp(s, 'm'), RP_TAPER_KNEE, 'sixty cycles from a full-commit signing land exactly on the knee');
  for (let w = 61; w <= 84; w += 1) s = runToBoundary(s);
  assert.ok(rp(s, 'm') >= 1000, `the dividend-max tier is not crossed until cycle 84 (${rp(s, 'm')})`);
  assertSumHolds(s, 'eighty-odd full-terms cycles');
});

test('an UNLICENSED guild is untouched — no key, no total, not one byte', () => {
  let s = fixture([mine('m')]);
  for (let i = 0; i < 2 * N; i += 1) s = tick(s);

  assert.equal(ven(s, 'm').reputation, undefined, 'no verdict was ever reached, so no key exists');
  assert.equal(guild(s).guildReputation, 0);
  assert.equal(canonicalStringify(s).includes('"reputation"'), false,
    'the string "reputation" appears nowhere in an unlicensed run’s serialized state');
  assertSumHolds(s, 'unlicensed run');
});

// --- 9. several ventures accumulate INDEPENDENTLY --------------------------------

test('two ventures on opposite verdicts move independently, and the guild total is their sum', () => {
  // `a` sits in SYS and is starved into breach; `b` sits in SYS_B on the paced default and
  // meets. One guild, one boundary, two different fates — and two different magnitudes,
  // because they signed different terms.
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B, equityPct: FULL_EQUITY })]);
  s = starve(licenceAll(s, ['a', 'b']), SYS);
  s = runToBoundary(s);

  const verdicts = guild(s).lastLicenceFee.ventures;
  assert.equal(verdicts.a.status, 'breach');
  assert.equal(verdicts.b.status, 'met');
  // ⤳ 01-09-26 (slice 2): both signed at the same full commitment, so both opened on the
  // same bump and their DIVERGENCE from it is what the verdicts did.
  assert.equal(rp(s, 'a'), BUMP_FULL_COMMIT - DROP_FULL_COMMIT, 'the breacher fell by ITS terms');
  assert.equal(rp(s, 'b'), BUMP_FULL_COMMIT + GAIN_FULL_TERMS, 'the meeter climbed by ITS terms');
  assert.equal(guild(s).guildReputation, 2 * BUMP_FULL_COMMIT + GAIN_FULL_TERMS - DROP_FULL_COMMIT,
    'and the guild total is the SUM of the two, not either one');
  assertSumHolds(s, 'two ventures, opposite verdicts');

  for (let w = 2; w <= 4; w += 1) {
    s = runToBoundary(s);
    assert.equal(rp(s, 'a'), BUMP_FULL_COMMIT - w * DROP_FULL_COMMIT);
    assert.equal(rp(s, 'b'), BUMP_FULL_COMMIT + w * GAIN_FULL_TERMS);
    assertSumHolds(s, `window ${w}`);
  }
});

test('a venture licensed LATER starts from its OWN bump and inherits no sibling’s standing', () => {
  // ⤳ RETITLED 01-09-26 (slice 2). "Starts from zero" is no longer true — a late joiner
  // starts from its own signing bump — but the claim that mattered is untouched and is
  // what this still checks: it inherits NOTHING from the incumbent's accumulated cycles,
  // and its first verdict moves it by exactly one verdict's worth.
  let s = licenceAll(fixture([mine('a'), mine('b', { systemId: SYS_B })]), ['a']);
  s = runToBoundary(s);
  s = runToBoundary(s);
  assert.equal(rp(s, 'a'), BUMP_FULL_COMMIT + 2 * GAIN_COMMIT_ONLY);
  assert.equal(ven(s, 'b').reputation, undefined, 'unlicensed, so no key at all');

  s = licenceAll(s, ['b']);
  assert.equal(rp(s, 'b'), BUMP_FULL_COMMIT, 'signing mints its own bump — not a share of its sibling’s');
  s = runToBoundary(s);
  assert.equal(rp(s, 'a'), BUMP_FULL_COMMIT + 3 * GAIN_COMMIT_ONLY, 'the incumbent kept climbing on its own count');
  assert.equal(rp(s, 'b') - BUMP_FULL_COMMIT,
    reputationDelta(guild(s).lastLicenceFee.ventures.b.status, ven(s, 'b')),
    'the newcomer moved by exactly one verdict — its FIRST');
  assert.ok(rp(s, 'b') < rp(s, 'a'), 'and it is still behind the venture that has been earning for three cycles');
  assertSumHolds(s, 'a late joiner');
});

// --- 10. integrality and the band ------------------------------------------------

test('reputation stays an INTEGER and IN BAND through a long mixed run (§15.2, §2.1)', () => {
  let s = starve(licenceAll(fixture([
    mine('a'), mine('b', { systemId: SYS_B, equityPct: FULL_EQUITY }),
  ]), ['a', 'b']), SYS);
  for (let i = 0; i < 8 * N; i += 1) {
    s = tick(s);
    for (const v of guild(s).ventures) {
      if (v.reputation === undefined) continue;
      assert.ok(Number.isInteger(v.reputation), `venture ${v.id} went fractional at tick ${s.tick}`);
      assert.ok(v.reputation >= RP_FLOOR && v.reputation <= RP_SOFT_CAP,
        `venture ${v.id} left the band at tick ${s.tick}: ${v.reputation}`);
    }
    assert.ok(Number.isInteger(guild(s).guildReputation), `the guild total went fractional at tick ${s.tick}`);
  }
  assertSumHolds(s, 'after eight windows');
});

test('a venture driven deep NEGATIVE keeps every invariant green — the exemption works', () => {
  // Seventy breached windows at a full commitment: 200 − 210 = −10, comfortably negative
  // and comfortably inside the band. Invariant 3's non-negativity carve-out has to cover
  // both the venture field and the guild total, or the tick would halt on a venture doing
  // exactly what breaching is designed to do.
  //
  // ⤳ 01-09-26 (slice 2): this used to take EIGHT windows and now takes seventy — because
  // a venture that signed at 100% opens 200 RP up and has to burn through its own signing
  // bump before it can go negative at all. That is the bump working as ruled (maximum
  // commitment buys a real buffer), not the test being padded: the assertion is still that
  // it DOES reach negative through the ordinary tick, and that nothing halts when it does.
  const WINDOWS = 70;
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  for (let w = 0; w < WINDOWS; w += 1) s = runToBoundary(s);

  assert.equal(rp(s, 'm'), BUMP_FULL_COMMIT - WINDOWS * DROP_FULL_COMMIT);
  assert.ok(rp(s, 'm') < 0, 'the test is vacuous unless it really went negative');
  assert.equal(guild(s).guildReputation, BUMP_FULL_COMMIT - WINDOWS * DROP_FULL_COMMIT);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'all invariants green on a deeply negative venture');
});

// --- 11. the tripwires fail LOUD (broken on purpose) -----------------------------

test('TRIPWIRE: a venture forced BELOW the floor is caught', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'green before it is broken');

  const broken = atRP(structuredClone(s), 'm', -600);
  const v = checkInvariants(broken, broken.tick);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'reputation-in-band (points-and-reputation.md §2.1)');
  assert.deepEqual(v[0].detail, { value: -600, floor: RP_FLOOR, softCap: RP_SOFT_CAP });
});

test('TRIPWIRE: a venture forced ABOVE the soft cap is caught', () => {
  // The half of the band NOTHING enforces directly — the top is held only by the taper's
  // arithmetic, so this check is the sole thing standing between a future retune of the
  // knee, the cap or REP_MEET_MAX and a silent overshoot.
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  const broken = atRP(structuredClone(s), 'm', 1600);
  const v = checkInvariants(broken, broken.tick);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'reputation-in-band (points-and-reputation.md §2.1)');
  assert.equal(v[0].detail.value, 1600);
  // Exactly at the cap is legal — the band is inclusive.
  assert.deepEqual(checkInvariants(atRP(structuredClone(s), 'm', RP_SOFT_CAP), s.tick), []);
  assert.deepEqual(checkInvariants(atRP(structuredClone(s), 'm', RP_FLOOR), s.tick), []);
});

test('TRIPWIRE: a guild total that drifts from its ventures is caught', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  const drifted = structuredClone(s);
  drifted.guilds[0].guildReputation += 1;
  const v = checkInvariants(drifted, drifted.tick);
  assert.equal(v.length, 1);
  // The rule generalised on 31-08-26 (A′, §2.5): the total is the ventures PLUS the
  // one-time founding endowment. This fixture is a `createState` guild, never founded, so
  // its endowment is 0 and the sum is still the ventures alone — but the detail now names
  // both terms, so a future drift says WHICH half moved.
  assert.equal(v[0].rule, 'guild-reputation-is-the-venture-sum-plus-endowment (points-and-reputation.md §2/§2.5)');
  const standing = BUMP_FULL_COMMIT + GAIN_COMMIT_ONLY;   // the signing bump, then one met cycle
  assert.deepEqual(v[0].detail, {
    stored: standing + 1,
    sumOfVentures: standing,
    foundingEndowment: 0,
    expected: standing,
  });
});

test('TRIPWIRE: a FRACTIONAL reputation is caught on the venture and on the guild', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  const broken = structuredClone(s);
  broken.guilds[0].ventures[0].reputation = 20.5;
  broken.guilds[0].guildReputation = 20.5;      // kept consistent, so ONLY integrality fails
  const rules = checkInvariants(broken, broken.tick).map((x) => x.rule);
  assert.deepEqual(rules, ['integer credits/goods (§15.2)', 'integer credits/goods (§15.2)'],
    'both the venture field and the guild total are integer-checked, and nothing else tripped');
});

test('TRIPWIRE: a NEGATIVE reputation is NOT reported — the carve-out is real, not accidental', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  const negative = atRP(structuredClone(s), 'm', -400);
  assert.deepEqual(checkInvariants(negative, negative.tick), [], 'negative RP inside the band is legal');

  const alsoNegativeHoard = structuredClone(negative);
  alsoNegativeHoard.guilds[0].fuelHoard = -1;
  const rules = checkInvariants(alsoNegativeHoard, alsoNegativeHoard.tick).map((x) => x.rule);
  assert.ok(rules.includes('non-negativity (invariant 3)'),
    'a field WITHOUT the carve-out still fails, so the exemption is targeted');
});

// --- 12. serialization: positive, negative, and omitted-when-0 --------------------

test('omitted-when-0: a fresh venture carries no reputation key, a seeded one does', () => {
  const s = createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures: [
      { id: 'zero', ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD, productionRate: 5 },
      { id: 'plus', ownerGuildId: 'g1', type: 'mining', systemId: SYS_B, resourceType: GOOD, productionRate: 5, reputation: 340 },
      { id: 'minus', ownerGuildId: 'g1', type: 'mining', systemId: 'sysC', resourceType: GOOD, productionRate: 5, reputation: -260 },
    ] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(ven(s, 'zero'), 'reputation'), false,
    'a 0 carries NO key — this is what keeps an unlicensed galaxy byte-identical');
  assert.equal(ven(s, 'plus').reputation, 340);
  assert.equal(ven(s, 'minus').reputation, -260, 'and the sign is not lost');
});

test('serialize -> persist -> load round-trips positive, negative and omitted-when-0', (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-reputation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A real run, so the values under test were MOVED by the engine rather than typed in:
  // `a` breaches its way negative, `b` meets its way positive, `c` is never licensed.
  //
  // ⤳ 01-09-26 (slice 2): `a` is signed at 10% and `b` at the full 100%, where they used to
  // share one commitment. That is not a dodge — it is the bump's own arithmetic doing the
  // work. A token committer opens on a bump of 20 and breaches at −9, so three breached
  // windows take it to −7; a full committer would have opened 200 up and needed seventy.
  // "Promise nothing, start behind" is exactly what puts a negative in this fixture.
  let s = fixture([
    mine('a'), mine('b', { systemId: SYS_B, equityPct: FULL_EQUITY }), mine('c', { systemId: 'sysC' }),
  ]);
  s = starve(licenceAll(licenceAll(s, ['a'], 0.1), ['b'], 1), SYS);
  for (let w = 0; w < 3; w += 1) s = runToBoundary(s);

  assert.ok(rp(s, 'a') < 0, 'the round trip is only a proof if a negative is present');
  assert.ok(rp(s, 'b') > 0, '...and a positive');
  assert.equal(ven(s, 'c').reputation, undefined, '...and an omitted-when-0');

  saveState(s, dir);
  const restored = loadOrInit(dir, () => { throw new Error('a state file was written — initFn must not run'); });

  assert.equal(hashState(restored), hashState(s), 'the whole state round-tripped, byte for byte');
  assert.equal(restored.guilds[0].ventures.find((v) => v.id === 'a').reputation, rp(s, 'a'));
  assert.equal(restored.guilds[0].ventures.find((v) => v.id === 'b').reputation, rp(s, 'b'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(restored.guilds[0].ventures.find((v) => v.id === 'c'), 'reputation'),
    false,
    'the absent key came back absent — it was not resurrected as a 0',
  );
  assert.equal(restored.guilds[0].guildReputation, guild(s).guildReputation);
  assertSumHolds(restored, 'after a reload');
});

test('determinism (invariant 9): a run that moves reputation is byte-identical run twice', () => {
  const run = () => {
    let s = fixture([mine('a'), mine('b', { systemId: SYS_B, equityPct: FULL_EQUITY })]);
    s = starve(licenceAll(s, ['a', 'b']), SYS);
    for (let w = 0; w < 3; w += 1) s = runToBoundary(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});

// --- 13. the snapshot surface -----------------------------------------------------

test('the snapshot reports both numbers, ECHOED not re-summed, and needs no schema bump', () => {
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B, equityPct: FULL_EQUITY })]);
  s = starve(licenceAll(s, ['a', 'b']), SYS);
  // ⤳ 01-09-26 (slice 2): `a` opens on a +200 signing bump, so one breached boundary no
  // longer takes it negative. `atRP` stands in for the breached cycles that would burn the
  // bump off — the same stand-in the band tests above use — so the snapshot still has a
  // real negative to echo, which is the claim under test.
  s = atRP(s, 'a', 0);
  s = runToBoundary(s);

  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
  assert.equal(SNAPSHOT_SCHEMA, 7);

  const g = snap.guilds.find((x) => x.id === 'g1');
  const a = snap.ventures.find((x) => x.id === 'a');
  const b = snap.ventures.find((x) => x.id === 'b');
  assert.equal(g.guildReputation, guild(s).guildReputation, 'the guild total is the STORED number');
  assert.equal(a.reputation, -DROP_FULL_COMMIT, 'a negative reaches the client as a negative');
  assert.equal(b.reputation, BUMP_FULL_COMMIT + GAIN_FULL_TERMS, 'and the bump rides through untouched');
  assert.equal(g.guildReputation, a.reputation + b.reputation, 'and the published total really is their sum');
});

test('the snapshot reports an unjudged venture’s reputation as the 0 it means, never undefined', () => {
  const snap = buildSnapshot(fixture([mine('m')]));
  const v = snap.ventures.find((x) => x.id === 'm');
  assert.equal(v.reputation, 0, 'a client reads a number, not an absence (like equityPct)');
  assert.equal(snap.guilds[0].guildReputation, 0);
});

test('the snapshot is a pure read — building one moves no reputation', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);
  const before = hashState(s);
  buildSnapshot(s);
  buildSnapshot(s);
  assert.equal(hashState(s), before, 'derived telemetry: it reads state and mutates nothing');
});
