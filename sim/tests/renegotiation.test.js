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
  createLicenseDeuteriumMineAction, createRenegotiateLicenceAction, createSetWindowNAction,
} = require('../actions.js');
const {
  licenceFee, licenceEndTick,
  STANDING_CUT_AT_RISK, STANDING_CUT_STEADY, STANDING_CUT_STRONG,
  STRONG_FEE_DISCOUNT, COMMITMENT_STEP_STEADY, COMMITMENT_STEP_SUB_PAR,
  ventureStanding, renegotiationTerms,
} = require('../licence.js');
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

// Jump the clock to the licence's window-end so a renegotiation is admissible, WITHOUT
// running ticks (which would move prices/RP and cloud what each test is asserting).
function elapse(s, ventureId = 'mine_1') {
  s.tick = licenceEndTick(ventureOf(s, ventureId).licence, N);
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
