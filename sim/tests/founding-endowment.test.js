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

const HOME = 'sys_0002';
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
      siteId: 'pl_00004_n01', resourceType: 'titanium', productionRate: 5,
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
  const N = 4;
  const run = (send) => {
    let s = founded();
    s = applyValid(s, createEstablishVentureAction({
      guildId: 'newborn', ventureId: 'm1', siteId: 'pl_00004_n01',
      assetId: 'asset_newborn_miner_01', resourceType: 'titanium', productionRate: 10,
    }));
    s.windowN = N;
    s = intake(s, [createApplyForLicenceAction({
      guildId: 'newborn', ventureId: 'm1', committedOutputPct: 1, windowDays: 7,
    })]).state;
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

  const breached = run(0);                    // send nothing ⇒ breach every window
  assert.ok(guild(breached).ventures[0].reputation < 0, 'the breached run really did lose reputation');
  assert.ok(guild(breached).guildReputation < guild(breached).foundingEndowment,
    'and the total fell below the endowment — the endowment is not a floor on the total');
});

test('a venture earning its bar lifts the guild back onto its line', () => {
  // The loop the endowment is meant to leave intact: deploy a venture, start below the
  // line, earn your way back. Proven end to end rather than argued.
  const N = 4;
  let s = founded();
  s = applyValid(s, createEstablishVentureAction({
    guildId: 'newborn', ventureId: 'm1', siteId: 'pl_00004_n01',
    assetId: 'asset_newborn_miner_01', resourceType: 'titanium', productionRate: 10,
  }));
  s.windowN = N;
  s = intake(s, [createApplyForLicenceAction({
    guildId: 'newborn', ventureId: 'm1', committedOutputPct: 1, windowDays: 7,
  })]).state;

  const atStart = issuanceModifier(s, guild(s));
  assert.ok(atStart < 1, 'deploying a venture drops it below its line…');
  assert.ok(atStart > ISSUANCE_FLOOR, '…but not to the floor, because the home base is covered');

  for (let i = 0; i < 30 * N; i += 1) s = tick(s);
  assert.ok(issuanceModifier(s, guild(s)) > atStart, '…and meeting commitments earns it back up');
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
