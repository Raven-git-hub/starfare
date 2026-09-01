'use strict';

// meanline.test.js — the mean line and the issuance modifier (sim/meanline.js;
// docs/points-and-reputation.md §3, numbers in phase-1-tuning.md).
//
// This is the JOIN of the two halves that came before it: GP (sim/points.js) is how big a
// guild is, RP (sim/licence.js, stored on the guild) is how much it contributes, and the
// modifier is the second judged against the first. So the tests below are in two kinds,
// and the second kind is the one that matters:
//
//   - the ARITHMETIC: the formula, both clamps, the empty-guild guard.
//   - the CALIBRATION: whether `MEANLINE_K = 150` actually produces the four outcomes the
//     ruling claims for it — a dense guild on its line, a sprawler throttled, a
//     just-expanded guild at the floor, a developed big guild mildly buffed. Those are
//     built from the ENGINE's own numbers (a venture's resting RP walked out through the
//     real taper, GP from the real helper), not from hand-typed figures, so they test the
//     model rather than restating it.
//
// IT GRANTS NO FUEL. `fuelGranted = baseGrant × modifier` needs `baseGrant`, the unbuilt
// pool slice (§8). A test pins that no hoard moves.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const { hashState, canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints, W_SYS, TIER_WEIGHT } = require('../points.js');
const { gainFactor, metGain } = require('../licence.js');
const {
  MEANLINE_K, ISSUANCE_SENSITIVITY, ISSUANCE_FLOOR, ISSUANCE_CEIL,
  expectedReputation, issuanceModifier,
} = require('../meanline.js');

const W_T1 = TIER_WEIGHT[1];
const SYS = ['sys_0002', 'sys_0003', 'sys_0004', 'sys_0005'];

const claim = (guildId, landmarkId) => ({
  claimId: `claim_${guildId}_${landmarkId}`, ownerGuildId: guildId,
  landmarkId, landmarkKind: 'system', claimedAtTick: 0, contested: false,
});
const mine = (id, systemId) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: 'titanium', productionRate: 5,
});

// A guild holding `systems` systems, running `mines` mines, sitting at reputation `rp`.
function fixture({ systems = 0, mines = 0, rp = 0 } = {}) {
  const s = createState({
    guilds: [{
      id: 'g1', credits: 0, fuelHoard: 0,
      ventures: Array.from({ length: mines }, (_, i) => mine(`m${i}`, SYS[i % SYS.length])),
    }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    claims: SYS.slice(0, systems).map((id) => claim('g1', id)),
  });
  // Reputation is the guild's stored total; the ventures carry it, and the guild sum must
  // stay exact or `checkGuildReputationSum` would (rightly) trip.
  const vs = s.guilds[0].ventures;
  if (rp !== 0 && vs.length) {
    const each = Math.trunc(rp / vs.length);
    vs.forEach((v, i) => { v.reputation = i === 0 ? rp - each * (vs.length - 1) : each; });
  }
  s.guilds[0].guildReputation = vs.reduce((n, v) => n + (v.reputation || 0), 0);
  return s;
}
const guild = (s) => s.guilds[0];
const expected = (s) => expectedReputation(s, guild(s));
const modifier = (s) => issuanceModifier(s, guild(s));

// Where a venture's reputation RESTS — climbed through the REAL taper until the gain
// rounds away (§2.3's organic cap). Walked rather than asserted, because the calibration
// scenarios below are only meaningful if "a venture that always meets" is the engine's
// number and not a figure typed into this file.
function restingRP(gain) {
  let rp = 0;
  for (;;) {
    const step = Math.round(gain * gainFactor(rp));
    if (step <= 0) return rp;
    rp += step;
  }
}
// ⤳ 01-09-26: this venture now names a `resourceType`. `metGain` is tier-scaled since the
// rescale (§2.6), so it reads the venture's produced good — a termsless stub would (rightly)
// halt on an unknown tier rather than quietly earning at the tier-1 rate.
const MODERATE_TERMS = metGain(
  { ...mine('t', SYS[0]), equityPct: 0.245, licence: { committedOutputPct: 0.5 } },
);
const AT_REST = restingRP(MODERATE_TERMS);

// --- 1. the ruled constants -------------------------------------------------------

test('the mean line uses the ruled [FIRST-CUT] numbers', () => {
  // ⤳ RESCALED 01-09-26 (§2.6): k = 1, so expected RP simply EQUALS GP. The three
  // ISSUANCE_* knobs are deliberately UNCHANGED — the modifier is scale-invariant, so the
  // rescale had nothing to recalibrate in them.
  assert.equal(MEANLINE_K, 1);
  assert.equal(ISSUANCE_SENSITIVITY, 1.5);
  assert.equal(ISSUANCE_FLOOR, 0.3);
  assert.equal(ISSUANCE_CEIL, 1.5);
  // `expectedReputation` is an integer, and integral BY CONSTRUCTION — an integer k times
  // the integer GP, with no rounding. A fractional k would silently break that.
  assert.ok(Number.isInteger(MEANLINE_K), 'a fractional k would make the expectation fractional');
});

test('the knobs are ASYMMETRIC on purpose — falling below hurts more than rising above helps', () => {
  // The punishing-for-ambition lean (§3, ruled 31-08-26). Not a symmetric band, and not to
  // be tidied into one: the floor is 0.7 below neutral, the ceiling only 0.5 above.
  assert.ok(1 - ISSUANCE_FLOOR > ISSUANCE_CEIL - 1,
    'the drop to the floor must be deeper than the climb to the ceiling');
  assert.ok(ISSUANCE_FLOOR > 0, 'but the floor is above zero — no death spiral');
  assert.ok(ISSUANCE_FLOOR < 1 && ISSUANCE_CEIL > 1, 'and the neutral 1.0 sits inside the band');
});

// --- 2. expectedReputation --------------------------------------------------------

test('expectedReputation is MEANLINE_K × GP, exactly', () => {
  const s = fixture({ systems: 2, mines: 3 });
  assert.equal(guildPoints(s, guild(s)), 2 * W_SYS + 3 * W_T1);
  assert.equal(expected(s), MEANLINE_K * guildPoints(s, guild(s)));
  assert.equal(expected(s), 700, 'stated outright, not implied by the formula it tests');
  assert.equal(expected(s), guildPoints(s, guild(s)), 'at k = 1 the line simply IS the GP');
  assert.ok(Number.isInteger(expected(s)));
});

test('expectedReputation rises with EVERY kind of holding — that is the bar going up', () => {
  const base = fixture({ systems: 1, mines: 1 });
  assert.ok(expected(fixture({ systems: 2, mines: 1 })) > expected(base), 'a system raises the bar');
  assert.ok(expected(fixture({ systems: 1, mines: 2 })) > expected(base), 'and so does a venture');
  // §0's whole point: size alone earns nothing, it raises the bar you must clear. Grabbing
  // holdings moves this number and NOT the reputation beside it. The reputation here is
  // chosen so the SMALL guild is unclamped — below ~53% of its line every guild pins at
  // the floor together, and two floored guilds would compare equal and prove nothing.
  const onTheLine = MEANLINE_K * (W_SYS + W_T1);               // 300: modest sits exactly on its line
  const grabbed = fixture({ systems: 3, mines: 1, rp: onTheLine });
  const modest = fixture({ systems: 1, mines: 1, rp: onTheLine });
  assert.ok(expected(grabbed) > expected(modest));
  assert.equal(guild(grabbed).guildReputation, guild(modest).guildReputation, 'same RP…');
  assert.equal(modifier(modest), 1, '…the modest guild sits on its line…');
  assert.ok(modifier(grabbed) < modifier(modest), '…and the bigger guild is the worse off for the same RP');
  assert.equal(modifier(grabbed), ISSUANCE_FLOOR, 'far enough over its head to pin at the floor');
});

test('a guild holding nothing expects nothing', () => {
  assert.equal(expected(fixture({})), 0);
});

// --- 3. the modifier: the formula and its clamps ----------------------------------

test('the modifier is 1 + SENSITIVITY × gap / expected, unclamped in the middle', () => {
  // One system, one mine: GP 300, expected 300. Put RP at 3/4 of the line.
  const s = fixture({ systems: 1, mines: 1, rp: 225 });
  assert.equal(expected(s), 300);
  const gap = 225 - 300;
  assert.equal(modifier(s), 1 + ISSUANCE_SENSITIVITY * (gap / 300));
  assert.ok(Math.abs(modifier(s) - 0.625) < 1e-12, 'a quarter below the line is 0.625');
  assert.ok(modifier(s) > ISSUANCE_FLOOR && modifier(s) < ISSUANCE_CEIL, 'and it is genuinely unclamped here');
});

test('a guild exactly ON its line reads exactly 1.0', () => {
  const s = fixture({ systems: 1, mines: 1 });
  guild(s).ventures[0].reputation = expected(s);
  guild(s).guildReputation = expected(s);
  assert.equal(modifier(s), 1, 'no gap, no adjustment');
});

test('the FLOOR clamps a guild far below its line, and it is a real clamp', () => {
  const s = fixture({ systems: 4, mines: 1, rp: 0 });
  assert.equal(modifier(s), ISSUANCE_FLOOR);
  // Genuinely clamped: the raw formula wanted to go lower, and would go lower still.
  const raw = 1 + ISSUANCE_SENSITIVITY * ((0 - expected(s)) / expected(s));
  assert.ok(raw < ISSUANCE_FLOOR, `the unclamped value (${raw}) is below the floor`);
  // Even a deeply NEGATIVE reputation cannot push it under — the floor is the safety net
  // that stops a below-line guild death-spiralling to zero (§3).
  const debt = fixture({ systems: 4, mines: 1, rp: -500 });
  assert.equal(modifier(debt), ISSUANCE_FLOOR, 'a guild in reputational debt still draws the floor');
  assert.ok(modifier(debt) > 0, 'and the floor is above zero');
});

test('the CEIL clamps a guild far above its line', () => {
  // Twice its line, then five times it. (Pre-rescale these read 4470 and 4491; the RATIOS
  // are what the clamp acts on, and they are unchanged — §3's scale invariance.)
  const s = fixture({ systems: 1, mines: 1, rp: 600 });
  const raw = 1 + ISSUANCE_SENSITIVITY * ((guild(s).guildReputation - expected(s)) / expected(s));
  assert.ok(raw > ISSUANCE_CEIL, `the unclamped value (${raw}) is above the ceiling`);
  assert.equal(modifier(s), ISSUANCE_CEIL);
  // CEIL saturation is a FEATURE (§3): past this point more reputation buys no more fuel,
  // and price becomes the throttle instead.
  const higher = fixture({ systems: 1, mines: 1, rp: 1500 });
  assert.equal(modifier(higher), ISSUANCE_CEIL, 'more reputation past the ceiling buys nothing further');
});

test('the exact clamp CROSSINGS are where the formula puts them', () => {
  // floor at RP/expected = 1 − (1 − FLOOR)/SENSITIVITY; ceiling at 1 + (CEIL − 1)/SENS.
  const s = fixture({ systems: 1, mines: 1 });
  const exp = expected(s);
  const at = (ratio) => {
    const t = fixture({ systems: 1, mines: 1 });
    guild(t).ventures[0].reputation = Math.round(ratio * exp);
    guild(t).guildReputation = guild(t).ventures[0].reputation;
    return modifier(t);
  };
  const floorAt = 1 - (1 - ISSUANCE_FLOOR) / ISSUANCE_SENSITIVITY;      // 0.5333…
  const ceilAt = 1 + (ISSUANCE_CEIL - 1) / ISSUANCE_SENSITIVITY;        // 1.3333…
  assert.ok(at(floorAt + 0.01) > ISSUANCE_FLOOR, 'just above the crossing is unclamped');
  assert.ok(at(floorAt - 0.01) === ISSUANCE_FLOOR, 'just below it pins');
  assert.ok(at(ceilAt - 0.01) < ISSUANCE_CEIL, 'just under the ceiling crossing is unclamped');
  assert.ok(at(ceilAt + 0.01) === ISSUANCE_CEIL, 'just over it pins');
});

test('the modifier is SCALE-INVARIANT — twice the size needs twice the reputation to sit still', () => {
  // Ratio-based by construction (§3). The same relative standing gives the same modifier
  // whatever the absolute size, which is what stops it becoming a size bonus.
  const small = fixture({ systems: 1, mines: 1 });
  const big = fixture({ systems: 4, mines: 4 });
  for (const ratio of [0.6, 0.8, 1, 1.2]) {
    for (const s of [small, big]) {
      const exp = expected(s);
      const total = Math.round(ratio * exp);
      const vs = guild(s).ventures;
      const each = Math.trunc(total / vs.length);
      vs.forEach((v, i) => { v.reputation = i === 0 ? total - each * (vs.length - 1) : each; });
      guild(s).guildReputation = vs.reduce((n, v) => n + (v.reputation || 0), 0);
    }
    assert.ok(Math.abs(modifier(small) - modifier(big)) < 1e-9,
      `at ${ratio}× the line, a small and a large guild must read the same`);
  }
});

// --- 4. the empty-guild guard (§3, open question #7) ------------------------------

test('EMPTY-GUILD GUARD: GP 0 -> modifier exactly 1.0, and nothing divides by zero', () => {
  const s = fixture({});
  assert.equal(guildPoints(s, guild(s)), 0);
  assert.equal(expected(s), 0);
  const m = modifier(s);
  assert.equal(m, 1, 'a guild holding nothing is trivially ON its own line');
  assert.ok(Number.isFinite(m), 'never NaN');
  assert.ok(!Object.is(m, Infinity) && !Object.is(m, -Infinity));
  // The ruled answer sits inside the band, so the neutral case needs no clamping to be
  // legal — and no new-guild death spiral opens.
  assert.ok(m >= ISSUANCE_FLOOR && m <= ISSUANCE_CEIL);
});

test('the guard holds however much reputation a holding-nothing guild has', () => {
  // Reputation without holdings cannot happen through play (RP moves only via a licence,
  // which needs a venture), but the guard must not divide by zero for any input.
  for (const rp of [-500, 0, 1200]) {
    const s = fixture({});
    guild(s).guildReputation = rp;
    assert.equal(issuanceModifier(s, guild(s)), 1, `rp ${rp}`);
  }
});

test('a guild with an absent reputation total reads it as the 0 it means', () => {
  const s = fixture({ systems: 1, mines: 1 });
  delete guild(s).guildReputation;
  assert.equal(modifier(s), ISSUANCE_FLOOR, 'no reputation against a real bar is the floor, not a crash');
  assert.ok(Number.isFinite(modifier(s)));
});

// --- 5. THE CALIBRATION — does k = 1 do what the ruling claims? -------------------
//
// ⤳ RE-DERIVED 01-09-26 for the rescale (points-and-reputation.md §2.6), and the way it
// had to be re-derived is itself worth recording. Pre-rescale, "a venture at par" was read
// off the §2.3 TAPER: an all-meeting venture parked at ~1494, and `k = 150` was calibrated
// so three of those paid for one system. **That reading no longer holds, because the
// rescale deliberately did NOT rescale the band** (§2.6, "Deferred — the RP band"): the
// bounds are still −500 / 800 / 1500 while a mine's bar fell to 100, so a resting venture
// now banks ~14× its own bar instead of ~1.66×. The band is LOOSE at the new scale, by
// ruling, until it gets its own pass.
//
// So par is taken from the LINE itself now, not from the taper — `PAR_CARRY` below is the
// reputation per venture that puts the reference guild exactly on its line, computed from
// the engine's own `expectedReputation`, not typed in. The four scenarios and the four
// ratios they assert are UNCHANGED; only where "par" is sourced from moved. When the band
// is ruled, the taper test below should come back into agreement with this one.

// The reference guild: one system, three producers — §3's "par is about three ventures per
// held system", which the rescale preserved by keeping W_SYS : W_T1 at 2 : 1.
const PAR_CARRY = Math.round(expected(fixture({ systems: 1, mines: 3 })) / 3);   // 167

test('CALIBRATION: a venture that always meets rests FAR above its bar — the band is loose', () => {
  // The taper still parks an all-meeting venture just under the 1500 soft cap, exactly as
  // it did before — the band was not rescaled. What CHANGED is what that resting figure
  // MEANS: a tier-1 mine's bar is now 100, so resting at 1431 is ~14× the bar it had to
  // clear, where pre-rescale 1494 was ~1.66× a bar of 900.
  //
  // ⚠ THIS TEST IS THE TRIPWIRE ON A KNOWN, RULED GAP, not a passing grade. §2.6 defers
  // the band's own rescale to the next ruling, and names the sub-choice it carries (one
  // global band, or a per-tier band scaled to the 1 : 1.5 : 3 : 5 spread). Do NOT "fix"
  // these numbers by rescaling the band here — that is a ruling, not a build.
  assert.equal(MODERATE_TERMS, 5, 'moderate terms: half commitment, half the equity ceiling');
  assert.equal(AT_REST, 1431);
  assert.equal(restingRP(10), 1466, 'and full terms rests barely higher — the cap dominates the terms');
  assert.ok(AT_REST > 10 * W_T1, `a venture rests at ${AT_REST}, more than 10× its ${W_T1}-point bar`);
});

test('CALIBRATION: a DENSE at-par guild sits ≈ on its line', () => {
  // One system, three ventures each carrying par. This is what k = 1 preserves: "par" is
  // about three producers per held system.
  const s = fixture({ systems: 1, mines: 3, rp: 3 * PAR_CARRY });
  assert.equal(guildPoints(s, guild(s)), W_SYS + 3 * W_T1);          // 500
  assert.equal(expected(s), 500);
  assert.equal(guild(s).guildReputation, 501);
  const m = modifier(s);
  assert.ok(Math.abs(m - 1) < 0.01, `a dense par guild reads ${m.toFixed(3)} — on its line`);
});

test('CALIBRATION: a SPRAWLER with the SAME production is throttled to ~0.33', () => {
  // The identical three ventures, spread across three systems instead of one. Same output,
  // same reputation, more territory — and the modifier collapses. This is
  // density-beats-sprawl (§2) as an actual number, and it reads the SAME 0.33 it read
  // pre-rescale: the modifier is a ratio, so the rescale could not move it.
  const dense = fixture({ systems: 1, mines: 3, rp: 3 * PAR_CARRY });
  const sprawl = fixture({ systems: 3, mines: 3, rp: 3 * PAR_CARRY });
  assert.equal(guild(sprawl).guildReputation, guild(dense).guildReputation, 'identical reputation…');
  assert.equal(guild(sprawl).ventures.length, guild(dense).ventures.length, '…and identical production');
  assert.ok(expected(sprawl) > expected(dense), 'but a far higher bar');
  const m = modifier(sprawl);
  assert.ok(Math.abs(m - 0.33) < 0.01, `the sprawler reads ${m.toFixed(3)} — throttled`);
  assert.ok(m > ISSUANCE_FLOOR, 'throttled but not yet pinned — the floor is still below it');
});

test('CALIBRATION: a JUST-EXPANDED guild pins at the floor until its reputation catches up', () => {
  // The punishing-for-ambition case, and the sequence is the point: GP jumps the moment
  // the claims exist, while the RP that would pay for them has not been earned.
  const before = fixture({ systems: 1, mines: 3, rp: 3 * PAR_CARRY });
  assert.ok(Math.abs(modifier(before) - 1) < 0.01, 'it starts on its line');

  const after = fixture({ systems: 4, mines: 3, rp: 3 * PAR_CARRY });
  assert.equal(guild(after).guildReputation, guild(before).guildReputation, 'not one point of RP was earned');
  assert.equal(modifier(after), ISSUANCE_FLOOR, 'and it drops straight to the floor');

  // …and it climbs back out by EARNING, not by shrinking: enough reputation lifts it off
  // the floor with the holdings untouched.
  const recovered = fixture({ systems: 4, mines: 3, rp: Math.round(0.8 * MEANLINE_K * guildPoints(after, guild(after))) });
  assert.ok(modifier(recovered) > ISSUANCE_FLOOR, 'reputation, not retreat, is the way back');
});

test('CALIBRATION: a DEVELOPED big guild is mildly buffed — earned size is not punished', () => {
  // The other half of the lean, and the half that makes it fair: a guild that really has
  // earned its size sits above its line. Eight ventures over two systems — denser than the
  // three-per-system reference, so it earns a buff for it.
  const s = fixture({ systems: 2, mines: 8, rp: 8 * PAR_CARRY });
  const m = modifier(s);
  assert.ok(m > 1, `a developed big guild reads ${m.toFixed(3)} — above its line`);
  assert.ok(m < ISSUANCE_CEIL, '…mildly, not saturated');
  assert.ok(Math.abs(m - 1.17) < 0.01);
});

// --- 6. derived, and it grants nothing --------------------------------------------

test('DERIVED: neither figure is stored, on the guild or in serialized state', () => {
  let s = fixture({ systems: 2, mines: 3, rp: 2000 });
  assert.ok(expected(s) > 0 && modifier(s) !== 1, 'there are real figures here, if anything stored them');

  assert.equal(guild(s).expectedReputation, undefined);
  assert.equal(guild(s).issuanceModifier, undefined);
  const json = canonicalStringify(s);
  assert.equal(json.includes('expectedReputation'), false);
  assert.equal(json.includes('issuanceModifier'), false);

  for (let i = 0; i < 3; i += 1) s = tick(s);
  assert.equal(canonicalStringify(s).includes('issuanceModifier'), false, 'and ticking mints nothing');
});

test('DERIVED: computing either figure is PURE — it moves not one byte', () => {
  const s = fixture({ systems: 2, mines: 3, rp: 2000 });
  const before = hashState(s);
  expectedReputation(s, guild(s));
  issuanceModifier(s, guild(s));
  buildSnapshot(s);
  assert.equal(hashState(s), before);
});

test('IT GRANTS NO FUEL — the modifier multiplies nothing today', () => {
  // `fuelGranted = baseGrant × modifier` needs `baseGrant`, the unbuilt pool slice (§8).
  // A guild pinned at the CEILING gains not one unit of fuel from it.
  let s = fixture({ systems: 1, mines: 1, rp: 1490 * 3 });
  guild(s).fuelHoard = 500;
  assert.equal(modifier(s), ISSUANCE_CEIL, 'maximally buffed…');
  const hoard = guild(s).fuelHoard;
  for (let i = 0; i < 5; i += 1) s = tick(s);
  assert.equal(guild(s).fuelHoard, hoard, '…and its hoard did not move by one unit');
  // Nor does the floor take any away.
  let starved = fixture({ systems: 4, mines: 1, rp: 0 });
  guild(starved).fuelHoard = 500;
  assert.equal(modifier(starved), ISSUANCE_FLOOR);
  for (let i = 0; i < 5; i += 1) starved = tick(starved);
  assert.equal(guild(starved).fuelHoard, 500);
});

// --- 7. the snapshot surface ------------------------------------------------------

test('the snapshot publishes both figures, from the engine helpers', () => {
  const s = fixture({ systems: 2, mines: 3, rp: 3 * AT_REST });
  const g = buildSnapshot(s).guilds[0];
  assert.equal(g.expectedReputation, expected(s));
  assert.equal(g.issuanceModifier, modifier(s));
  assert.equal(g.guildPoints, guildPoints(s, guild(s)), 'beside the GP it is derived from');
  assert.equal(g.guildReputation, guild(s).guildReputation, 'and the RP it judges');
  assert.equal(buildSnapshot(s).schemaVersion, 7, 'additive — no schema bump');
});

test('the snapshot reports the ruled 1.0 for a guild holding nothing, never an absence', () => {
  const g = buildSnapshot(fixture({})).guilds[0];
  assert.equal(g.expectedReputation, 0);
  assert.equal(g.issuanceModifier, 1);
});

test('the four published figures tell one story, and the snapshot does not re-derive any of them', () => {
  // RP, GP, the line and the verdict — the snapshot must carry all four consistently, or
  // a reader could see a modifier that its own expected/RP pair does not produce.
  const s = fixture({ systems: 3, mines: 3, rp: 3 * AT_REST });
  const g = buildSnapshot(s).guilds[0];
  assert.equal(g.expectedReputation, MEANLINE_K * g.guildPoints);
  const raw = 1 + ISSUANCE_SENSITIVITY * ((g.guildReputation - g.expectedReputation) / g.expectedReputation);
  assert.equal(g.issuanceModifier, Math.max(ISSUANCE_FLOOR, Math.min(ISSUANCE_CEIL, raw)));
});
