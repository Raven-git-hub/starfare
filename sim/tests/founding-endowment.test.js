'use strict';

// founding-endowment.test.js — the guild founding endowment (A′;
// docs/points-and-reputation.md §2.5, the ruling this pins).
//
// THE DEFECT IT FIXES. Points count held systems; reputation is earned per venture. A guild
// founded a moment ago holds its home system (GP 200) and has no ventures — the starter
// assets it was just gifted are IDLE INVENTORY and score nothing — so its bar is
// `MEANLINE_K × W_SYS` = 200 against an RP of 0, and the issuance modifier pins at the
// FLOOR. Every brand-new guild was throttled to 30% fuel before it had any chance to earn.
// The mean line cannot tell "just founded" from "holds territory and does nothing with it"
// on structure alone: both read as all-system-Points, zero-venture-reputation.
//
// THE RULING. Founding grants a one-time guild-level `foundingEndowment` sized at
// `MEANLINE_K × systemPoints`, neutralising the granted home base EXACTLY ONCE. Everything
// beyond it is still earned, which is what these tests are really for: the endowment must
// fix the newborn WITHOUT softening density-beats-sprawl or the k = 1 calibration.
//
// ⤳ RESCALED 01-09-26 (200 → 200), points-and-reputation.md §2.6, WITH NO EDIT TO
// `foundingEndowmentFor`. That is the ruling's own claim made good: the endowment is the
// product of `MEANLINE_K` (150 → 1) and `W_SYS` (12 → 200), both ruled elsewhere, so it
// TRACKED the rescale instead of drifting from it. Only the figures pinned below moved.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  intake, validateAction, applyAction,
  createFoundGuildAction, createEstablishVentureAction, createApplyForLicenceAction,
  createSetProductionProfileAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { W_SYS, systemPoints, guildPoints } = require('../points.js');
const {
  MEANLINE_K, ISSUANCE_FLOOR, expectedReputation, issuanceModifier, foundingEndowmentFor,
} = require('../meanline.js');

const HOME = HOME_SYSTEM;
const OTHER = 'sys_0009';

const applyValid = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.ok(valid, `action ${action.type} unexpectedly rejected: ${reason}`);
  return applyAction(state, action);
};

// A galaxy with ONE guild, founded through the real action path — the only path that
// grants an endowment.
function founded(over = {}) {
  return applyValid(createZeroState(), createFoundGuildAction({
    guildId: 'newborn', credits: 120, influence: 100, homeSystemId: HOME, ...over,
  }));
}
const guild = (s) => s.guilds.find((g) => g.id === 'newborn');

// --- 1. THE ACCEPTANCE TEST -------------------------------------------------------

test('ACCEPTANCE: a bare-founded guild opens ON ITS LINE, not pinned at the floor', () => {
  const s = founded();
  const g = guild(s);

  // The shape the defect came from is still exactly as it was — this is not fixed by
  // pretending a newborn is smaller than it is.
  assert.equal(guildPoints(s, g), W_SYS, 'it holds its home system and nothing else');
  assert.equal(g.ventures.length, 0, 'founding creates no ventures');
  assert.ok(g.assets.length > 0, 'the starter gift is real…');
  assert.equal(expectedReputation(s, g), MEANLINE_K * W_SYS, '…and scores nothing: the bar is the home system alone');

  // What changed: the endowment covers that bar exactly.
  assert.equal(issuanceModifier(s, g), 1, 'a newborn reads exactly 1.0 — it was 0.30, the floor');
  assert.ok(issuanceModifier(s, g) > ISSUANCE_FLOOR);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 2. DERIVED, NOT HARDCODED -----------------------------------------------------

test('the endowment is MEANLINE_K × W_SYS × held systems, read from the constants', () => {
  const s = founded();
  const g = guild(s);
  // Stated against the constants, so this goes red if either retunes and the endowment
  // stops tracking it — the whole point of deriving rather than typing 200 in.
  assert.equal(g.foundingEndowment, MEANLINE_K * W_SYS * 1);
  assert.equal(g.foundingEndowment, MEANLINE_K * systemPoints(s, g));
  assert.equal(g.foundingEndowment, foundingEndowmentFor(s, g));
  assert.equal(g.foundingEndowment, 200, 'stated outright too, so the arithmetic is checkable by eye');
  assert.ok(Number.isInteger(g.foundingEndowment), 'integer reputation (§15.2)');
  assert.ok(g.foundingEndowment >= 0, 'a grant is never negative');
});

test('the endowment sizes off the SYSTEM half of Points, never the whole of it', () => {
  // The restraint the ruling turns on. A founding that carries inline ventures endows the
  // home system only — ventures earn their own bar (§1.2) — so using `guildPoints` here
  // would have quietly endowed them too and softened the whole model.
  const s = founded({
    ventures: [{
      id: 'inline_mine', ownerGuildId: 'newborn', type: 'mining',
      siteId: HOME_MINE, resourceType: 'titanium', productionRate: 5,
    }],
  });
  const g = guild(s);
  assert.equal(g.ventures.length, 1, 'the founding really did attach an inline venture');
  assert.ok(guildPoints(s, g) > systemPoints(s, g), 'so its Points exceed its system half');
  assert.equal(g.foundingEndowment, MEANLINE_K * systemPoints(s, g), 'and the endowment tracks the SYSTEM half');
  assert.notEqual(g.foundingEndowment, MEANLINE_K * guildPoints(s, g), 'not the whole of Points');
  // Consequence: an inline-founded guild starts BELOW its line, because the venture it
  // carries has not earned anything yet.
  assert.ok(issuanceModifier(s, g) < 1, 'the un-earned venture leaves it below its line');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 3. DENSITY-BEATS-SPRAWL IS PRESERVED ------------------------------------------

test('EXPANSION STILL SINKS YOU: a second system has no matching endowment', () => {
  // The endowment must not become a general "territory is free" rule. It neutralises the
  // home base once; every system after it raises the bar with nothing to cover it.
  const s = founded();
  assert.equal(issuanceModifier(s, guild(s)), 1, 'on its line with the home system alone');

  const grown = structuredClone(s);
  grown.claims.push({
    claimId: 'claim_newborn_second', ownerGuildId: 'newborn',
    landmarkId: OTHER, landmarkKind: 'system', claimedAtTick: 0, contested: false,
  });
  const g = guild(grown);
  assert.equal(guildPoints(grown, g), 2 * W_SYS, 'it now holds two systems');
  assert.equal(g.foundingEndowment, MEANLINE_K * W_SYS, 'but the endowment did not grow');
  assert.ok(issuanceModifier(grown, g) < 1, 'so it sits below its line — sprawl still costs');
  assert.deepEqual(checkInvariants(grown, grown.tick), []);
});

test('the endowment is set ONCE and never recomputed as holdings change', () => {
  const s = founded();
  const before = guild(s).foundingEndowment;
  const grown = structuredClone(s);
  grown.claims.push({
    claimId: 'claim_newborn_second', ownerGuildId: 'newborn',
    landmarkId: OTHER, landmarkKind: 'system', claimedAtTick: 0, contested: false,
  });
  let ticked = grown;
  for (let i = 0; i < 3; i += 1) ticked = tick(ticked);
  assert.equal(guild(ticked).foundingEndowment, before, 'ticking does not re-derive it');
});

// --- 4. THE SUM TRIPWIRE HOLDS THROUGH PLAY ----------------------------------------

test('the sum tripwire holds every tick through a MET boundary and a BREACHED one', () => {
  // The generalisation under real movement: `guildReputation == Σ venture.reputation +
  // foundingEndowment`. The tick's per-venture mover adds `after − before` to the total and
  // knows nothing about the endowment — which is safe only because the endowment is
  // constant. This drives a licensed venture through boundaries both ways and re-checks the
  // sum on every single tick.
  //
  // ⤳ 01-09-26 (slice 2): signing now MINTS RP too, so the endowment is no longer the only
  // thing on the guild's books before the first boundary. That makes this test stronger,
  // not weaker — the sum now has to survive a mint at signing AND a move at every boundary,
  // through two different writers in two different files.
  const N = 4;
  const run = (send, commitPct = 1) => {
    let s = founded();
    s = applyValid(s, createEstablishVentureAction({
      guildId: 'newborn', ventureId: 'm1', siteId: HOME_MINE,
      assetId: 'asset_newborn_miner_01', resourceType: 'titanium', productionRate: 10,
    }));
    s.windowN = N;
    s = intake(s, [createApplyForLicenceAction({
      guildId: 'newborn', ventureId: 'm1', committedOutputPct: commitPct, windowDays: 7,
    })]).state;
    // The sum must already hold at signing, BEFORE any tick — the mint site's own check.
    {
      const g = guild(s);
      const ventureSum = g.ventures.reduce((n, v) => n + (v.reputation || 0), 0);
      assert.equal(g.guildReputation, ventureSum + g.foundingEndowment,
        'at signing: the bump moved the venture and the guild total by the same amount');
    }
    if (send !== null) {
      s = intake(s, [createSetProductionProfileAction({
        guildId: 'newborn', systemId: HOME, goods: { titanium: { syndicate: { mode: 'absolute', value: send } } },
      })]).state;
    }
    for (let i = 0; i < 4 * N; i += 1) {
      s = tick(s);
      const g = guild(s);
      const ventureSum = g.ventures.reduce((n, v) => n + (v.reputation || 0), 0);
      assert.equal(g.guildReputation, ventureSum + g.foundingEndowment,
        `tick ${s.tick}: the total must be the ventures plus the endowment`);
      assert.deepEqual(checkInvariants(s, s.tick), [], `tick ${s.tick}: an invariant tripped`);
    }
    return s;
  };

  const met = run(null);                      // the paced default delivers Q exactly ⇒ met
  assert.ok(guild(met).ventures[0].reputation > 0, 'the met run really did earn reputation');
  assert.ok(guild(met).guildReputation > guild(met).foundingEndowment, 'so the total rose above the endowment');

  // ⤳ 01-09-26: the breached run signs at 10%, not 100%. A full committer opens on a +200
  // signing bump and four breached windows (−3 each) leave it comfortably positive, so it
  // could no longer show what this half of the test is for. A token committer opens on 20
  // and breaches at −9, so it goes negative — and it is the venture the ruling INTENDS to
  // end up there ("promise nothing, start behind").
  const breached = run(0, 0.1);               // send nothing ⇒ breach every window
  assert.ok(guild(breached).ventures[0].reputation < 0, 'the breached run really did lose reputation');
  assert.ok(guild(breached).guildReputation < guild(breached).foundingEndowment,
    'and the total fell below the endowment — the endowment is not a floor on the total');
});

// THE SIGNING BUMP AT FOUNDING SCALE (§2.6, ruled + BUILT 01-09-26, slice 2 of the
// rescale) — where the terms a guild signs decide where its first venture opens.
//
// ⤳ THIS SECTION REPLACES A TEST WHOSE PREMISE THE SLICE DELETED, and the replacement is
// the record of what changed. The old test read "a venture earning its bar lifts the guild
// back onto its line" and opened by asserting `modifier < 1` — *deploying a venture drops
// you below your line*. That was true, and it was the defect §2.6 exists to remove: the
// endowment covered the HOME SYSTEM's bar, but every venture deployed after it raised the
// bar instantly with no reputation to pay for it, so a guild was throttled for doing the
// thing the game is about. The bump makes that a CHOICE the deploy slider sets, and the
// three cases below are the whole ruling, end to end through the real actions.
//
// The arithmetic behind them: a founded guild holds one home system (GP 200, endowed 200)
// and this one tier-1 mine (GP 100, weight 100). So the guild's bar is 300, and the mine's
// bump is `2 × commit × 100` — 0 / 100 / 200 at 0% / 50% / 100%.

const signAt = (commitPct) => {
  let s = founded();
  s = applyValid(s, createEstablishVentureAction({
    guildId: 'newborn', ventureId: 'm1', siteId: HOME_MINE,
    assetId: 'asset_newborn_miner_01', resourceType: 'titanium', productionRate: 10,
  }));
  s.windowN = 4;
  return intake(s, [createApplyForLicenceAction({
    guildId: 'newborn', ventureId: 'm1', committedOutputPct: commitPct, windowDays: 7,
  })]).state;
};

test('SIGNING AT 50% LANDS THE VENTURE EXACTLY ON ITS LINE — the founding-drop fix', () => {
  // §2.6's headline: 50% is the Syndicate's EXPECTED deal and is bar-neutral. The venture
  // adds 100 GP and mints exactly 100 RP, so the guild's reputation and its bar move by
  // the same amount and the modifier does not budge off neutral.
  const s = signAt(0.5);
  const g = guild(s);

  assert.equal(guildPoints(s, g), 300, 'home system 200 + a tier-1 mine 100');
  assert.equal(expectedReputation(s, g), 300, 'and at MEANLINE_K = 1 the bar simply IS the GP');
  assert.equal(g.ventures[0].reputation, 100, 'the bump is 2 x 0.5 x 100 — the mine\'s own GP');
  assert.equal(g.guildReputation, 300, 'endowment 200 + bump 100');
  assert.equal(issuanceModifier(s, g), 1, 'so it sits EXACTLY on its line — no gap at all');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('SIGNING AT 100% LAUNCHES IT ABOVE ITS LINE — an instant fuel buff', () => {
  const s = signAt(1);
  const g = guild(s);
  assert.equal(g.ventures[0].reputation, 200, 'twice the mine\'s GP');
  assert.equal(g.guildReputation, 400);
  assert.ok(issuanceModifier(s, g) > 1, 'above its line, and drawing more fuel for it');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('SIGNING AT 0% LEAVES IT BELOW ITS LINE — promise nothing, start behind', () => {
  const s = signAt(0);
  const g = guild(s);
  // No bump, and therefore NO KEY: a zero move writes nothing, exactly as a zero-delta
  // verdict does in the tick. The venture added 100 to the bar and nothing to the credit.
  assert.equal(g.ventures[0].reputation, undefined, 'a zero bump mints no key at all');
  assert.equal(g.guildReputation, 200, 'the endowment alone — the venture paid for nothing');
  assert.ok(issuanceModifier(s, g) < 1, 'below its line, and throttled for it');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the three terms are ORDERED — the deploy slider really is the lever', () => {
  const at = (pct) => { const s = signAt(pct); return issuanceModifier(s, guild(s)); };
  assert.ok(at(0) < at(0.5), 'more commitment is never worse…');
  assert.ok(at(0.5) < at(1), '…at either step');
  assert.equal(at(0.5), 1, 'and the middle one is the neutral deal');
});

test('a below-line venture EARNS its way back — the loop the endowment left intact', () => {
  // Signed at 20%: a bump of 40 against a bar of 100, so it opens below its line and has
  // to climb. This is the loop the old pre-bump test proved for EVERY venture; the bump
  // means only an under-committed one now walks it.
  let s = signAt(0.2);
  const atStart = issuanceModifier(s, guild(s));
  assert.ok(atStart < 1, 'a 20% signing opens below its line');
  assert.ok(atStart > ISSUANCE_FLOOR, 'but not at the floor — the home base is still covered');
  for (let i = 0; i < 30 * 4; i += 1) s = tick(s);
  assert.ok(issuanceModifier(s, guild(s)) > atStart, 'and meeting commitments earns it back up');
});

test('⚠ A 0%-COMMITMENT VENTURE CANNOT EARN ITS WAY BACK AT ALL — it is stuck until it renegotiates', () => {
  // Worth pinning loudly, because it is the sharpest edge the ruling has and it is easy to
  // read §2.6's "promise nothing, start behind" as merely a slow start. It is not. A 0%
  // licence owes zero units, so it is `met` every window — but `metGain` is terms-scaled,
  // and zero terms met scores exactly zero (§2: you do not earn RP for OWNING). So the
  // venture gets no bump AND no earnings: it sits below its line for ever, throttling its
  // guild's fuel, with no move available inside the current contract.
  //
  // THE WAY OUT IS THE RENEGOTIATION WINDOW (#64), WHICH IS NOT BUILT — so today this is a
  // genuine trap rather than a choice with a cost. Flagged on the roadmap's decision
  // checklist rather than softened here: whether signing at 0% should be refused outright,
  // or the bump should carry a floor, is a ruling and not a build.
  let s = signAt(0);
  const atStart = issuanceModifier(s, guild(s));
  for (let i = 0; i < 30 * 4; i += 1) s = tick(s);

  assert.equal(guild(s).lastLicenceFee.ventures.m1.status, 'met', 'it is judged MET every window…');
  assert.equal(guild(s).ventures[0].reputation, undefined, '…and earns exactly nothing for it');
  assert.equal(issuanceModifier(s, guild(s)), atStart, 'thirty cycles later it has not moved one point');
  assert.ok(atStart < 1, 'and it is below its line the whole time');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 5. THE EMPTY-GUILD GUARD IS A SEPARATE PATH ------------------------------------

test('the empty-guild guard still stands — a guild holding NOTHING is not endowed', () => {
  // §3's `expectedRP === 0 → 1.0` is a different case from the endowment, and both reach
  // 1.0 by different routes. A guild that holds literally nothing has no endowment at all.
  const s = createState({
    guilds: [{ id: 'nothing', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  const g = s.guilds[0];
  assert.equal(guildPoints(s, g), 0);
  assert.equal(expectedReputation(s, g), 0);
  assert.equal(g.foundingEndowment, undefined, 'never founded, so never endowed');
  assert.equal(issuanceModifier(s, g), 1, 'and the GUARD, not the endowment, puts it at 1.0');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 6. SERIALISATION: omitted when 0 ------------------------------------------------

test('the field is OMITTED when 0, so an unfounded guild is byte-identical', () => {
  const s = createState({
    guilds: [{ id: 'scenario', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(s.guilds[0], 'foundingEndowment'), false);
  assert.equal(canonicalStringify(s).includes('foundingEndowment'), false,
    'the string appears nowhere in a scenario-built galaxy — which is why those goldens did not move');

  // …but a value handed in is CARRIED, not silently dropped (the trap
  // `venture.committedFromTick` documents): a restored save must keep it or the sum
  // tripwire fires on the next tick.
  const carried = createState({
    guilds: [{ id: 'restored', credits: 0, fuelHoard: 0, ventures: [], foundingEndowment: 200 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal(carried.guilds[0].foundingEndowment, 200);
});

test('a founded guild ROUND-TRIPS through serialisation with its endowment intact', () => {
  const s = founded();
  const restored = JSON.parse(canonicalStringify(s));
  const g = restored.guilds.find((x) => x.id === 'newborn');
  assert.equal(g.foundingEndowment, 200);
  assert.equal(g.guildReputation, 200);
  assert.deepEqual(checkInvariants(restored, restored.tick), [], 'and the sum still holds after a reload');
});

// --- 7. TRIPWIRES ----------------------------------------------------------------

test('TRIPWIRE: a total that ignores the endowment is caught', () => {
  const s = founded();
  const broken = structuredClone(s);
  // The precise regression this generalisation guards: someone "fixes" the total back to
  // the venture sum alone.
  broken.guilds.find((g) => g.id === 'newborn').guildReputation = 0;
  const v = checkInvariants(broken, broken.tick);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'guild-reputation-is-the-venture-sum-plus-endowment (points-and-reputation.md §2/§2.5)');
  assert.deepEqual(v[0].detail, { stored: 0, sumOfVentures: 0, foundingEndowment: 200, expected: 200 });
});

test('TRIPWIRE: a FRACTIONAL endowment is caught by the integer check', () => {
  const s = founded();
  const broken = structuredClone(s);
  const g = broken.guilds.find((x) => x.id === 'newborn');
  g.foundingEndowment = 200.5;
  g.guildReputation = 200.5;                 // kept consistent, so ONLY integrality fails
  const rules = checkInvariants(broken, broken.tick).map((x) => x.rule);
  assert.deepEqual(rules, ['integer credits/goods (§15.2)', 'integer credits/goods (§15.2)'],
    'both the endowment and the total it feeds are integer-checked, and nothing else tripped');
});

// --- 8. THE SNAPSHOT SURFACE ---------------------------------------------------------

test('the snapshot publishes the endowment beside the total it is part of', () => {
  const g = buildSnapshot(founded()).guilds.find((x) => x.id === 'newborn');
  assert.equal(g.foundingEndowment, 200);
  assert.equal(g.guildReputation, 200);
  assert.equal(g.guildPoints, W_SYS);
  assert.equal(g.expectedReputation, MEANLINE_K * W_SYS);
  assert.equal(g.issuanceModifier, 1, 'the row reads as one story: endowed, on its line');
  assert.equal(buildSnapshot(founded()).schemaVersion, 7, 'additive — no schema bump');
});

test('the snapshot reports 0 for a guild that was never founded, never an absence', () => {
  const snap = buildSnapshot(createState({
    guilds: [{ id: 'scenario', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  }));
  assert.equal(snap.guilds[0].foundingEndowment, 0);
});
