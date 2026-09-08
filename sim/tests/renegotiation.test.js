'use strict';

// renegotiation.test.js — licence renegotiation, #64 Slice 1 (engine + snapshot derive;
// design.md §5 "Licence renegotiation — the terms function & venture standing", 08-09-26;
// numbers docs/phase-1-tuning.md §"…venture-standing bands & terms function"; build note
// docs/renegotiation.md).
//
// The mechanical tripwires this slice must add (§18 #4):
//   - ventureStanding's exact band edges;
//   - renegotiationTerms by band — the commitment ladder, the Strong fee discount, and
//     window + equity carried unchanged;
//   - the renegotiateLicence action — rejects before the window elapses and for
//     unlicensed / not-owned / deuterium ventures; on accept it re-locks in place with
//     NO signing bump (RP and the guild sum unmoved), a reset signedTick, carried
//     windowDays, a re-priced fee (×(1−discount) when strong), and a recomputed
//     syndicateCommitment + committedFromTick; every invariant still holds;
//   - the snapshot's `standing` (always, licensed non-deuterium) and `renegotiationOffer`
//     (only once expired; absent for unlicensed and deuterium).
//
// The arithmetic each test asserts against is STATED from the licence's own stored terms
// and the phase-1-tuning constants (imported, never re-typed), not read back off the
// helper under test, so a test cannot pass by agreeing with a wrong implementation.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { advance } = require('../run.js');
const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const {
  intake,
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createLicenseDeuteriumMineAction, createRenegotiateLicenceAction, createLapseLicenceAction,
  createSetWindowNAction,
} = require('../actions.js');
const {
  licenceFee, licenceEndTick,
  STANDING_CUT_AT_RISK, STANDING_CUT_STEADY, STANDING_CUT_STRONG,
  STRONG_FEE_DISCOUNT, COMMITMENT_STEP_STEADY, COMMITMENT_STEP_SUB_PAR,
  ventureStanding, renegotiationTerms,
  graceDaysFor, ACCEPTANCE_WINDOW_DAYS, renegotiationSchedule, applyLapse,
} = require('../licence.js');
const { tick: tickOnce } = require('../tick.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const GUILD = 'player-guild';
const N = 4;                                    // a short accrual window, so terms resolve fast
const M1 = 'asset_player-guild_miner_01';       // one of the fifteen Miners the founding gifts

const guildOf = (s) => s.guilds.find((g) => g.id === GUILD);
const ventureOf = (s, id) => guildOf(s).ventures.find((v) => v.id === id);
const rowOf = (s, id) => buildSnapshot(s).ventures.find((v) => v.id === id);

// ─── ventureStanding: exact band edges ───────────────────────────────────────────

test('ventureStanding — exact band edges (−300 / 0 / 500)', () => {
  const band = (rp) => ventureStanding({ reputation: rp });
  // just below and at the −300 forced-lease mark → atRisk
  assert.equal(band(STANDING_CUT_AT_RISK - 1), 'atRisk');   // −301
  assert.equal(band(STANDING_CUT_AT_RISK), 'atRisk');       // −300 (inclusive)
  // above it but below the bump-floor 0 → subPar
  assert.equal(band(STANDING_CUT_AT_RISK + 1), 'subPar');   // −299
  assert.equal(band(STANDING_CUT_STEADY - 1), 'subPar');    // −1
  // 0 up to (not including) 500 → steady
  assert.equal(band(STANDING_CUT_STEADY), 'steady');        // 0 (inclusive)
  assert.equal(band(STANDING_CUT_STRONG - 1), 'steady');    // 499
  // 500 and up → strong
  assert.equal(band(STANDING_CUT_STRONG), 'strong');        // 500 (inclusive)
});

test('ventureStanding — a missing reputation reads as 0 (Steady), never throws', () => {
  assert.equal(ventureStanding({}), 'steady');
  assert.equal(ventureStanding(null), 'steady');
});

// ─── renegotiationTerms: the table by band ───────────────────────────────────────

// A minimal licensed venture the pure terms function reads — its licence carries the
// committed pct and window, the venture carries RP and equity. equityPct lives on the
// VENTURE (a §5 Slice 3a establish term), not on the licence.
const licVenture = (rp, commit, { windowDays = 14, equityPct = 0.2 } = {}) => ({
  id: 'm', reputation: rp, equityPct,
  licence: { committedOutputPct: commit, windowDays, signedTick: 0, lockedPrice: 10, basicFee: 100, discountedFee: 50 },
});

test('renegotiationTerms — Strong keeps commitment and carries the fee discount', () => {
  const t = renegotiationTerms(licVenture(STANDING_CUT_STRONG, 0.5, { windowDays: 21 }));
  assert.equal(t.committedOutputPct, 0.5, 'unchanged — a strong venture may coast');
  assert.equal(t.windowDays, 21, 'window carried');
  assert.equal(t.feeDiscount, STRONG_FEE_DISCOUNT, 'the only band that moves the fee');
});

test('renegotiationTerms — Steady steps commitment up by the small step, no discount', () => {
  const t = renegotiationTerms(licVenture(0, 0.5, { windowDays: 14 }));
  assert.equal(t.committedOutputPct, Math.min(1, 0.5 + COMMITMENT_STEP_STEADY));
  assert.equal(t.windowDays, 14);
  assert.equal(t.feeDiscount, 0);
});

test('renegotiationTerms — Sub-par steps commitment up by the bigger step', () => {
  const t = renegotiationTerms(licVenture(-100, 0.5));
  assert.equal(t.committedOutputPct, Math.min(1, 0.5 + COMMITMENT_STEP_SUB_PAR));
  assert.equal(t.feeDiscount, 0);
});

test('renegotiationTerms — At-risk jumps straight to full commitment', () => {
  const t = renegotiationTerms(licVenture(-400, 0.3));
  assert.equal(t.committedOutputPct, 1, 'a jump to full, not a step');
  assert.equal(t.feeDiscount, 0);
});

test('renegotiationTerms — the Steady/Sub-par steps clamp at 1.0', () => {
  assert.equal(renegotiationTerms(licVenture(0, 0.95)).committedOutputPct, 1, 'steady +step clamped');
  assert.equal(renegotiationTerms(licVenture(-100, 0.9)).committedOutputPct, 1, 'subPar +step clamped');
});

test('renegotiationTerms — window and equity are untouched in EVERY band', () => {
  for (const rp of [-400, -100, 0, STANDING_CUT_STRONG]) {
    const v = licVenture(rp, 0.5, { windowDays: 30, equityPct: 0.3 });
    const t = renegotiationTerms(v);
    assert.equal(t.windowDays, 30, `rp ${rp}: window carried`);
    assert.equal(v.equityPct, 0.3, `rp ${rp}: equity not mutated`);
    assert.ok(!('equityPct' in t) && !('equity' in t), `rp ${rp}: terms name no equity`);
  }
});

test('renegotiationTerms — a venture with no ordinary licence throws (nothing to renegotiate)', () => {
  assert.throws(() => renegotiationTerms({ id: 'm', reputation: 100 }), /no ordinary licence|has none/);
});

// ─── float-creep normalisation (2 dp) ────────────────────────────────────────────
// Plain float addition creeps: `0.7 + 0.10 === 0.7999999999999999`, which flows into the
// stored licence pct and compounds across renegotiations. `renegotiationTerms` normalises
// the returned commitment to 2 dp. Strict `===` here so the assertions FAIL on the creepy
// value — a tolerant `assert.ok(Math.abs(...) < 1e-9)` would pass on `0.7999…` and miss
// the whole point of the fix.

test('renegotiationTerms — a Steady step 0.7 → 0.8 is EXACT (no float creep)', () => {
  // `0.7 + COMMITMENT_STEP_STEADY` is `0.7999999999999999` before normalisation.
  const t = renegotiationTerms(licVenture(0, 0.7));   // Steady (0 ≤ rp < 500)
  assert.strictEqual(t.committedOutputPct, 0.8);
});

test('renegotiationTerms — a Steady CHAIN 0.5 → 0.6 → 0.7 → 0.8 stays exact at each step', () => {
  // Each accepted step re-locks the licence at the stepped pct; feed that back in and
  // renegotiate again, exactly as successive window-ends would. Creep would accumulate.
  let commit = 0.5;
  for (const expected of [0.6, 0.7, 0.8]) {
    commit = renegotiationTerms(licVenture(0, commit)).committedOutputPct;
    assert.strictEqual(commit, expected);
  }
});

test('renegotiationTerms — a Sub-par step 0.7 → 0.95 is EXACT', () => {
  const t = renegotiationTerms(licVenture(-100, 0.7));   // Sub-par (−300 < rp < 0)
  assert.strictEqual(t.committedOutputPct, 0.95);
});

test('renegotiationTerms — an already-clean value is unchanged (Strong coasts at exactly 0.5)', () => {
  const t = renegotiationTerms(licVenture(STANDING_CUT_STRONG, 0.5));
  assert.strictEqual(t.committedOutputPct, 0.5);
});

test('renegotiationTerms — At-risk returns exactly 1', () => {
  const t = renegotiationTerms(licVenture(STANDING_CUT_AT_RISK - 1, 0.3));
  assert.strictEqual(t.committedOutputPct, 1);
});

// ─── the renegotiateLicence action ───────────────────────────────────────────────

function founded() {
  return advance(createZeroState(), [
    createSetWindowNAction({ windowN: N }),
    createFoundGuildAction({ guildId: GUILD, credits: 500, influence: 100, homeSystemId: HOME_SYSTEM }),
  ]).state;
}

// Found, establish a titanium mine on HOME_MINE, license it. equityPct is an ESTABLISH
// term, so it rides the establish action, not the licence.
function licensedMine({ committedOutputPct = 0.5, windowDays = 7, equityPct } = {}) {
  return advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5, ...(equityPct === undefined ? {} : { equityPct }),
    }),
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct, windowDays }),
  ]).state;
}

// Force a venture's RP to a chosen band, keeping `checkGuildReputationSum` exact by
// moving the guild's cached total by the SAME delta (the invariant the tick maintains).
function setReputation(s, ventureId, rp) {
  const v = ventureOf(s, ventureId);
  const g = guildOf(s);
  g.guildReputation += rp - (v.reputation || 0);
  v.reputation = rp;
}

// Jump the clock to the licence's ACTS tick — past window-end AND past the grace window, so
// the Syndicate has acted and the offer is open (#64 Slice 2). WITHOUT running ticks (which
// would move prices/RP and cloud what each test is asserting). `actsTick` is ≥ the raw
// `licenceEndTick` the action gate uses, so the accept/reject/lapse actions are admissible too.
function elapse(s, ventureId = 'mine_1') {
  const lic = ventureOf(s, ventureId).licence;
  const anchor = s.dayAnchorTick == null ? 0 : s.dayAnchorTick;
  s.tick = renegotiationSchedule(lic, N, anchor).actsTick;
  return s;
}

const renegotiate = (s, ventureId = 'mine_1', guildId = GUILD) =>
  intake(s, [createRenegotiateLicenceAction({ guildId, ventureId })]);

test('rejects a renegotiation BEFORE the committed window has elapsed', () => {
  const s = licensedMine({ windowDays: 7 });      // window ends 7×N ticks after signing; we are far short
  const before = hashState(s);
  const { results } = renegotiate(s);
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /window has not elapsed/);
  assert.equal(hashState(s), before, 'a rejected action moves nothing');
});

test('rejects an UNLICENSED venture (sign one first, do not renegotiate)', () => {
  const s = advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5,
    }),
  ]).state;
  const { results } = renegotiate(s);
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /no licence to renegotiate/);
});

test('rejects a venture the guild does NOT own', () => {
  const s = elapse(licensedMine());
  const { results, state } = renegotiate(s, 'no-such-venture');
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /has no venture with id/);
  assert.equal(hashState(state), hashState(s), 'no-op');
});

test('rejects a DEUTERIUM mine — windowless and exempt (§1.4)', () => {
  // A licensed deuterium mine built directly: it carries `deuteriumLicence`, never an
  // ordinary `licence`, and it must be refused with the deuterium-specific reason.
  const s = createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: HOME_SYSTEM,
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: 1000,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  const { results } = renegotiate(s, 'deut_1');
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /windowless and exempt/);
});

test('on ACCEPT (Steady) — re-locks in place, NO signing bump, fee re-locked at the new commit', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', 0);                  // Steady (0 ≤ rp < 500)
  const before = ventureOf(s, 'mine_1');
  const oldWindowDays = before.licence.windowDays;
  const rpBefore = before.reputation;
  const guildRpBefore = guildOf(s).guildReputation;
  const signTick = s.tick;

  const { results, state } = renegotiate(s);
  assert.equal(results[0].accepted, true);

  const v = ventureOf(state, 'mine_1');
  const expectedCommit = Math.min(1, 0.5 + COMMITMENT_STEP_STEADY);
  // The new terms, re-locked in place.
  assert.equal(v.licence.committedOutputPct, expectedCommit, 'commitment stepped up');
  assert.equal(v.licence.windowDays, oldWindowDays, 'window carried unchanged');
  assert.equal(v.licence.signedTick, signTick, 'signedTick reset to now (window resets)');
  assert.equal(v.committedFromTick, signTick + 1, 'pro-rate anchor re-stamped to the new first producing tick');
  // The fee is re-priced at today's posted price and the NEW commit, with NO discount off
  // Strong — byte-for-byte what a fresh licenceFee returns for those terms.
  const price = v.licence.lockedPrice;
  const { basicFee, discountedFee } = licenceFee({
    baselineUnitsPerTick: 5, windowN: N, lockedPrice: price,
    committedOutputPct: expectedCommit, equityPct: 0,
  });
  assert.equal(v.licence.basicFee, basicFee, 'basic fee re-locked, undiscounted off Strong');
  assert.equal(v.licence.discountedFee, discountedFee);
  // syndicateCommitment recomputed off the new pct.
  assert.equal(v.syndicateCommitment, Math.round(expectedCommit * 5 * N));

  // NO signing bump: RP untouched and the guild sum identical before/after.
  assert.equal(v.reputation, rpBefore, 'venture RP unchanged (no re-bump)');
  assert.equal(guildOf(state).guildReputation, guildRpBefore, 'guild RP sum identical');

  // Every invariant still holds (checkGuildReputationSum among them).
  assert.equal(checkInvariants(state).length, 0);
});

test('on ACCEPT (Strong) — the fee falls by exactly the Strong discount', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', STANDING_CUT_STRONG + 100);   // Strong
  const oldBasic = ventureOf(s, 'mine_1').licence.basicFee;

  const { state } = renegotiate(s);
  const v = ventureOf(state, 'mine_1');
  assert.equal(v.licence.committedOutputPct, 0.5, 'Strong keeps its commitment');

  // The re-locked fees are the undiscounted fee × (1 − STRONG_FEE_DISCOUNT), rounded.
  const price = v.licence.lockedPrice;
  const raw = licenceFee({
    baselineUnitsPerTick: 5, windowN: N, lockedPrice: price,
    committedOutputPct: 0.5, equityPct: 0,
  });
  assert.equal(v.licence.basicFee, Math.round(raw.basicFee * (1 - STRONG_FEE_DISCOUNT)));
  assert.equal(v.licence.discountedFee, Math.round(raw.discountedFee * (1 - STRONG_FEE_DISCOUNT)));
  assert.ok(v.licence.basicFee < oldBasic, 'the fee only ever FALLS at Strong');
  assert.equal(checkInvariants(state).length, 0);
});

test('on ACCEPT (At-risk) — commitment jumps to full', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.3, windowDays: 7 }));
  setReputation(s, 'mine_1', STANDING_CUT_AT_RISK - 50);   // At-risk
  const { state } = renegotiate(s);
  const v = ventureOf(state, 'mine_1');
  assert.equal(v.licence.committedOutputPct, 1);
  assert.equal(v.syndicateCommitment, Math.round(1 * 5 * N));
  assert.equal(checkInvariants(state).length, 0);
});

// ─── the snapshot derive ─────────────────────────────────────────────────────────

test('snapshot — a licensed venture carries `standing`; a not-yet-expired one has NO offer', () => {
  const s = licensedMine({ committedOutputPct: 0.5, windowDays: 7 });
  setReputation(s, 'mine_1', STANDING_CUT_STRONG + 10);    // Strong, so standing is legible
  const row = rowOf(s, 'mine_1');
  assert.equal(row.standing, 'strong');
  assert.equal(row.renegotiationOffer, null, 'no offer before the window elapses');
});

test('snapshot — an EXPIRED venture carries a `renegotiationOffer` matching the terms function', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', 0);                            // Steady
  const row = rowOf(s, 'mine_1');
  assert.equal(row.standing, 'steady');
  assert.ok(row.renegotiationOffer, 'expired → an offer is present');
  const terms = renegotiationTerms(ventureOf(s, 'mine_1'));
  assert.equal(row.renegotiationOffer.committedOutputPct, terms.committedOutputPct, 'offer commit == terms');
  assert.equal(row.renegotiationOffer.feeDiscountApplied, false, 'no discount off Strong');
  // The offered fee is what accepting would lock (the apply reads the SAME helper).
  const { state } = renegotiate(s);
  const locked = ventureOf(state, 'mine_1').licence;
  assert.equal(row.renegotiationOffer.basicFee, locked.basicFee, 'offered basic == locked basic');
  assert.equal(row.renegotiationOffer.discountedFee, locked.discountedFee);
});

test('snapshot — an expired STRONG venture flags the discount in its offer', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7 }));
  setReputation(s, 'mine_1', STANDING_CUT_STRONG + 100);   // Strong
  const row = rowOf(s, 'mine_1');
  assert.equal(row.renegotiationOffer.feeDiscountApplied, true);
});

test('snapshot — an UNLICENSED venture carries neither field', () => {
  const s = advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5,
    }),
  ]).state;
  const row = rowOf(s, 'mine_1');
  assert.ok(!('standing' in row), 'no standing on an unlicensed venture');
  assert.ok(!('renegotiationOffer' in row), 'no offer on an unlicensed venture');
});

test('snapshot — a DEUTERIUM mine carries neither field (windowless, §1.4)', () => {
  const s = createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: HOME_SYSTEM,
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: 1000,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  const row = rowOf(s, 'deut_1');
  assert.ok(!('standing' in row), 'no standing on a deuterium mine');
  assert.ok(!('renegotiationOffer' in row), 'no offer on a deuterium mine');
});

// ─── the lapseLicence action (REJECT → unlicensed) ───────────────────────────────
// The OTHER end of a reopened licence (§5 "Accept or lapse"): drop the licence and forfeit
// the venture's RP, keeping the venture in place. Same gate as renegotiateLicence; apply
// mirrors decommissionVenture's RP-forfeit + commitment-clear minus the removal.

const lapse = (s, ventureId = 'mine_1', guildId = GUILD) =>
  intake(s, [createLapseLicenceAction({ guildId, ventureId })]);

test('lapse — rejects BEFORE the committed window has elapsed', () => {
  const s = licensedMine({ windowDays: 7 });        // far short of window-end
  const before = hashState(s);
  const { results } = lapse(s);
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /window has not elapsed/);
  assert.equal(hashState(s), before, 'a rejected action moves nothing');
});

test('lapse — rejects an UNLICENSED venture (nothing to lapse)', () => {
  const s = advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5,
    }),
  ]).state;
  const { results } = lapse(s);
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /no licence to lapse/);
});

test('lapse — rejects a venture the guild does NOT own', () => {
  const s = elapse(licensedMine());
  const { results, state } = lapse(s, 'no-such-venture');
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /has no venture with id/);
  assert.equal(hashState(state), hashState(s), 'no-op');
});

test('lapse — rejects a DEUTERIUM mine (windowless, §1.4)', () => {
  const s = createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: HOME_SYSTEM,
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: 1000,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  const { results } = lapse(s, 'deut_1');
  assert.equal(results[0].accepted, false);
  assert.match(results[0].reason, /windowless and exempt/);
});

test('lapse — reverts to unlicensed, forfeits the venture RP, keeps the venture, moves no credit', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', 200);                  // a positive standing to forfeit
  const guildRpBefore = guildOf(s).guildReputation;
  const creditsBefore = guildOf(s).credits;
  const ledgerBefore = s.syndicate.ledger;

  const { results, state } = lapse(s);
  assert.equal(results[0].accepted, true);

  const v = ventureOf(state, 'mine_1');
  assert.ok(v, 'the venture SURVIVES the lapse (unlicensed, not removed)');
  assert.ok(!v.licence, 'the licence is gone');
  assert.ok(!('reputation' in v), 'the venture returns to the no-reputation state (RP forfeited)');
  assert.equal(v.syndicateCommitment, 0, 'windowed commitment cleared to the unlicensed value');
  assert.ok(!('committedFromTick' in v), 'the pro-rate anchor is cleared');

  // The guild sum dropped by EXACTLY the forfeited amount.
  assert.equal(guildOf(state).guildReputation, guildRpBefore - 200, 'guild RP dropped by the forfeit');

  // No fee, no credit moved anywhere.
  assert.equal(guildOf(state).credits, creditsBefore, 'no fee charged to the guild');
  assert.equal(state.syndicate.ledger, ledgerBefore, 'nothing moved to the Syndicate ledger');

  // No node lockout written (unlike a mid-term teardown) — lapse is a window-end settlement.
  assert.ok(!Array.isArray(state.nodeLockouts) || state.nodeLockouts.length === 0, 'no node lockout on lapse');

  // Every invariant holds (checkGuildReputationSum among them).
  assert.equal(checkInvariants(state).length, 0);
});

test('lapse — forfeiting a NEGATIVE RP RAISES the guild sum (the asymmetric escape valve, §5)', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.3, windowDays: 7 }));
  setReputation(s, 'mine_1', STANDING_CUT_AT_RISK - 100);   // −400: a ruined venture
  const guildRpBefore = guildOf(s).guildReputation;

  const { results, state } = lapse(s);
  assert.equal(results[0].accepted, true);

  const v = ventureOf(state, 'mine_1');
  assert.ok(!('reputation' in v), 'the negative RP is shed');
  // guildReputation -= (−400) ⇒ it RISES by 400. The escape-hatch is deliberately asymmetric.
  assert.equal(guildOf(state).guildReputation, guildRpBefore + 400, 'shedding a negative RP raises the guild sum');
  assert.equal(checkInvariants(state).length, 0);
});

test('lapse then RE-LICENSE — applyForLicence works on the lapsed venture and mints a FRESH bump', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', 200);
  const { state: lapsed } = lapse(s);
  assert.ok(!ventureOf(lapsed, 'mine_1').licence, 'unlicensed after lapse');

  // A fresh licence on the now-unlicensed venture is admissible and mints a new signing bump
  // (RP climbs from 0 again), exactly as a first signing does.
  const { results, state } = intake(lapsed, [
    createApplyForLicenceAction({ guildId: GUILD, ventureId: 'mine_1', committedOutputPct: 0.5, windowDays: 7 }),
  ]);
  assert.equal(results[0].accepted, true, 're-licensing the lapsed venture is admissible');
  const v = ventureOf(state, 'mine_1');
  assert.ok(v.licence, 'a fresh licence is in place');
  assert.ok((v.reputation || 0) > 0, 'a fresh signing bump was minted');
  assert.equal(checkInvariants(state).length, 0);
});

// ─── the attention derive (snapshot aggregation) ─────────────────────────────────

const attentionOf = (s) => buildSnapshot(s).attention;

test('attention — an expired-window venture surfaces in attention.renegotiations', () => {
  const s = elapse(licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 }));
  setReputation(s, 'mine_1', 0);                    // Steady
  const att = attentionOf(s);
  assert.ok(att && Array.isArray(att.renegotiations), 'attention.renegotiations is a list');
  assert.equal(att.renegotiations.length, 1, 'the one open offer is surfaced');
  const entry = att.renegotiations[0];
  assert.equal(entry.guildId, GUILD);
  assert.equal(entry.ventureId, 'mine_1');
  assert.equal(entry.standing, 'steady');
  assert.ok(typeof entry.ventureName === 'string' && entry.ventureName.length > 0, 'a display name is carried');
  // The offer is the SAME structure the venture row publishes.
  const row = rowOf(s, 'mine_1');
  assert.deepEqual(entry.offer, row.renegotiationOffer, 'the entry offer == the row offer');
});

test('attention — a NOT-yet-expired venture is NOT surfaced', () => {
  const s = licensedMine({ committedOutputPct: 0.5, windowDays: 7 });   // window far from end
  setReputation(s, 'mine_1', 0);
  assert.equal(attentionOf(s).renegotiations.length, 0, 'no offer before the window elapses');
});

test('attention — an UNLICENSED venture is NOT surfaced', () => {
  const s = advance(founded(), [
    createEstablishVentureAction({
      guildId: GUILD, ventureId: 'mine_1', siteId: HOME_MINE, assetId: M1,
      resourceType: 'titanium', productionRate: 5,
    }),
  ]).state;
  assert.equal(attentionOf(s).renegotiations.length, 0, 'an unlicensed venture is no action-item');
});

test('attention — a DEUTERIUM mine is NOT surfaced (windowless, §1.4)', () => {
  const s = createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: HOME_SYSTEM,
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: 1000,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  assert.equal(attentionOf(s).renegotiations.length, 0, 'a deuterium mine is windowless — never an action-item');
});

test('attention — after ACCEPT the offer clears; after LAPSE it clears too', () => {
  // ACCEPT re-locks (window resets) → no longer expired → drops off attention.
  const accepted = renegotiate(elapse(licensedMine({ windowDays: 7 }))).state;
  assert.equal(attentionOf(accepted).renegotiations.length, 0, 'accepting re-locks and clears the offer');

  // LAPSE unlicenses → no licence → drops off attention.
  const lapsed = lapse(elapse(licensedMine({ windowDays: 7 }))).state;
  assert.equal(attentionOf(lapsed).renegotiations.length, 0, 'lapsing unlicenses and clears the offer');
});

test('attention — the derive is read-only: byte-identical hash before and after buildSnapshot', () => {
  const s = elapse(licensedMine({ windowDays: 7 }));
  const before = hashState(s);
  buildSnapshot(s);   // building the read model must mutate NOTHING (invariant 9 read-model rule)
  assert.equal(hashState(s), before, 'the attention derive moves no serialized byte');
});

// ─── #64 Slice 2 — the timers ────────────────────────────────────────────────────

// graceDaysFor at every cutoff edge (phase-1-tuning: 1 / 3 / 4 / 5 at 14 / 21 / 28).
test('graceDaysFor — the exact cutoff edges', () => {
  const table = [[13, 1], [14, 3], [20, 3], [21, 4], [27, 4], [28, 5], [42, 5]];
  for (const [windowDays, expected] of table) {
    assert.equal(graceDaysFor(windowDays), expected, `windowDays ${windowDays}`);
  }
});

// The schedule's three DAY-ALIGNED ticks for a sample licence, all off the calendar.
test('renegotiationSchedule — three day-aligned ticks for a sample licence (signed day-aligned)', () => {
  // signedTick 1 = the first tick of day 0 (day-aligned). windowN 4, windowDays 7, grace(7)=1.
  const sched = renegotiationSchedule({ signedTick: 1, windowDays: 7 }, 4, 0);
  assert.equal(sched.windowEndTick, 29, 'window ends at the first tick of day 7 (tickAt(7,0)=29)');
  assert.equal(sched.actsTick, 33, 'the Syndicate acts one grace day later (day 8, tickAt(8,0)=33)');
  assert.equal(sched.lapseTick, 53, 'auto-lapse five acceptance days after that (day 13, tickAt(13,0)=53)');
  // The gaps are exactly the ruled day counts × windowN.
  assert.equal(sched.actsTick - sched.windowEndTick, graceDaysFor(7) * 4, 'grace gap = graceDays × N');
  assert.equal(sched.lapseTick - sched.actsTick, ACCEPTANCE_WINDOW_DAYS * 4, 'acceptance gap = 5 days × N');
});

// The OFFER is absent DURING grace and present FROM actsTick, and the countdown ticks down.
test('offer is gated on actsTick — quiet during grace, live after, with daysToLapse counting down', () => {
  const base = licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 });
  const lic = ventureOf(base, 'mine_1').licence;
  const sched = renegotiationSchedule(lic, N, 0);

  // Just before window-end, and DURING grace (window-end .. actsTick): standing but NO offer.
  for (const t of [sched.windowEndTick - 1, sched.windowEndTick, sched.actsTick - 1]) {
    const s = { ...base, tick: t };
    const row = rowOf(s, 'mine_1');
    assert.equal(row.standing, 'steady', `tick ${t}: standing is still read`);
    assert.equal(row.renegotiationOffer, null, `tick ${t}: no offer before the Syndicate acts (grace)`);
    assert.equal(attentionOf(s).renegotiations.length, 0, `tick ${t}: MESSAGES stays quiet during grace`);
  }

  // At actsTick the offer appears with the full acceptance countdown, and it counts DOWN by day.
  const atActs = rowOf({ ...base, tick: sched.actsTick }, 'mine_1');
  assert.ok(atActs.renegotiationOffer, 'the offer is live from actsTick');
  assert.equal(atActs.renegotiationOffer.lapseTick, sched.lapseTick, 'the offer carries its auto-lapse deadline');
  assert.equal(atActs.renegotiationOffer.daysToLapse, ACCEPTANCE_WINDOW_DAYS, 'respond in 5 days on the day it appears');
  // One day later → 4; the last day before lapse → 1.
  assert.equal(rowOf({ ...base, tick: sched.actsTick + N }, 'mine_1').renegotiationOffer.daysToLapse, 4, 'a day later, 4');
  assert.equal(rowOf({ ...base, tick: sched.lapseTick - 1 }, 'mine_1').renegotiationOffer.daysToLapse, 1, 'the last day reads 1');
});

// Tick a state forward until its clock reaches (or passes) `toTick`.
function runTo(s, toTick) {
  while (s.tick < toTick) s = tickOnce(s);
  return s;
}

// AUTO-LAPSE: a licence left unanswered past its lapseTick lapses on the tick, via the exact
// `applyLapse` effect — RP forfeited, guild sum exact, licence dropped, the venture SURVIVES.
test('auto-lapse — an unanswered licence lapses at lapseTick, keeping the venture (applyLapse effect)', () => {
  let s = licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 });
  const lic = ventureOf(s, 'mine_1').licence;
  const lapseTick = renegotiationSchedule(lic, N, 0).lapseTick;
  const endowment = guildOf(s).foundingEndowment || 0;

  // One tick BEFORE the deadline: still licensed (the offer is still standing).
  s = runTo(s, lapseTick - 1);
  assert.ok(ventureOf(s, 'mine_1').licence, `still licensed at tick ${s.tick} (before lapseTick ${lapseTick})`);
  assert.ok(rowOf(s, 'mine_1').renegotiationOffer, 'the offer is still open within the acceptance window');

  // Tick onto the deadline: the auto-lapse step fires.
  s = runTo(s, lapseTick);
  const v = ventureOf(s, 'mine_1');
  assert.ok(v, 'the venture SURVIVES the auto-lapse (unlicensed, not removed)');
  assert.ok(!v.licence, 'the licence is dropped');
  assert.ok(!('reputation' in v), 'its RP is forfeited (back to the no-reputation state)');
  assert.equal(v.syndicateCommitment, 0, 'windowed commitment cleared');
  assert.ok(!('committedFromTick' in v), 'the pro-rate anchor cleared');
  assert.ok(!rowOf(s, 'mine_1').renegotiationOffer, 'and the offer is gone — it dropped off MESSAGES');
  assert.equal(attentionOf(s).renegotiations.length, 0, 'the lapsed venture is off the attention list');
  // The guild sum is exactly the endowment now (the one venture forfeited all its RP).
  assert.equal(guildOf(s).guildReputation, endowment, 'guild RP sum is exact after the forfeit');
  assert.equal(checkInvariants(s).length, 0, 'every invariant holds after auto-lapse');
});

test('auto-lapse — an ACCEPTED venture never reaches it (accepting resets the schedule)', () => {
  const base = licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 });
  const origLapse = renegotiationSchedule(ventureOf(base, 'mine_1').licence, N, 0).lapseTick;
  // Accept once the offer is open (at actsTick), which re-locks and pushes the whole schedule out.
  const accepted = renegotiate(elapse(base)).state;
  const newLapse = renegotiationSchedule(ventureOf(accepted, 'mine_1').licence, N, 0).lapseTick;
  assert.ok(newLapse > origLapse, 'accepting pushed the auto-lapse deadline forward');
  // Tick past the ORIGINAL deadline: still licensed, because the schedule moved with the accept.
  const s = runTo(accepted, origLapse + 1);
  assert.ok(ventureOf(s, 'mine_1').licence, 'a re-locked venture is not auto-lapsed at the old deadline');
});

test('auto-lapse — a REJECTED venture is already unlicensed; ticking past the deadline is a no-op', () => {
  const base = licensedMine({ committedOutputPct: 0.5, windowDays: 7, equityPct: 0 });
  const lapseTick = renegotiationSchedule(ventureOf(base, 'mine_1').licence, N, 0).lapseTick;
  const rejected = lapse(elapse(base)).state;   // REJECT → unlicensed immediately
  assert.ok(!ventureOf(rejected, 'mine_1').licence, 'unlicensed the moment it is rejected');
  const s = runTo(rejected, lapseTick + 1);
  assert.ok(ventureOf(s, 'mine_1'), 'the venture is still present past the old deadline');
  assert.ok(!ventureOf(s, 'mine_1').licence, 'and still unlicensed — nothing to auto-lapse');
  assert.equal(checkInvariants(s).length, 0);
});

test('auto-lapse — a DEUTERIUM mine is never auto-lapsed (windowless, §1.4)', () => {
  const s = createState({
    guilds: [{
      id: GUILD, credits: 0, fuelHoard: 0,
      ventures: [{
        id: 'deut_1', ownerGuildId: GUILD, type: 'mining', systemId: HOME_SYSTEM,
        resourceType: 'deuterium', productionRate: 5,
        deuteriumLicence: { signedTick: 0 }, reputation: 1000,
      }],
    }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 }, windowN: N,
  });
  let t = s;
  for (let i = 0; i < 60; i += 1) t = tickOnce(t);
  const v = ventureOf(t, 'deut_1');
  assert.ok(v.deuteriumLicence, 'still deuterium-licensed after 60 ticks — no ordinary licence to lapse');
  assert.ok(!v.licence, 'it never carried an ordinary licence, so the auto-lapse step never touched it');
  // A licensed deuterium mine EARNS RP each cycle (deuteriumMetGain), so its RP is not forfeited —
  // it climbs. The point is that it was never auto-lapsed: its standing survives and grows.
  assert.ok(v.reputation >= 1000, 'its RP survives (and accrues) rather than being forfeited');
});
