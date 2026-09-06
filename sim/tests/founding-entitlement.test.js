'use strict';

// founding-entitlement.test.js — the Fuel Δ founding baseline (Slice D′;
// docs/guild-hall.md §2, the expected-fuel-change gauge).
//
// THE GAP IT CLOSES. The Fuel Δ gauge (Slice D) divides `predictedGrant` (the guild's LIVE
// entitlement) by `fuelGrant.entitlement` (this cycle's, stamped at a cycle boundary). Before
// a guild's FIRST boundary there is no stamped entitlement, so the gauge read `—` from
// creation. This slice stamps `guild.foundingEntitlement = grantFor(next, guild)` in the
// `foundGuild` apply — the credit entitlement at the instant of founding — and the client falls
// the gauge's denominator back to it, so the gauge is live (opening at ×1.00) from tick 0.
//
// It is an HONEST dedicated baseline, mirroring `foundingEndowment` (founding-endowment.test.js)
// — NOT a synthesised grant record: no grant happened, so no boundary machinery or grant
// tripwire ever sees a phantom one (asserted below).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HOME_SYSTEM, HOME_MINE } = require('./home-anchor.js');

const { createZeroState } = require('../scenarios/zero-state.js');
const { createState } = require('../state.js');
const { tick } = require('../tick.js');
const {
  validateAction, applyAction,
  createFoundGuildAction, createEstablishVentureAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { canonicalStringify } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints, W_SYS } = require('../points.js');
const { issuanceModifier } = require('../meanline.js');
const { grantFor, BASE_GRANT_PER_GP } = require('../issuance.js');

const HOME = HOME_SYSTEM;

const applyValid = (state, action) => {
  const { valid, reason } = validateAction(state, action);
  assert.ok(valid, `action ${action.type} unexpectedly rejected: ${reason}`);
  return applyAction(state, action);
};

// A galaxy with ONE guild, founded through the real action path — the only path that stamps
// the baseline. `windowN` short so a boundary is reachable in a few ticks.
function founded(over = {}) {
  const s = applyValid(createZeroState(), createFoundGuildAction({
    guildId: 'newborn', credits: 120, influence: 100, homeSystemId: HOME, ...over,
  }));
  s.windowN = 4;
  return s;
}
const guild = (s) => s.guilds.find((g) => g.id === 'newborn');
const row = (s) => buildSnapshot(s).guilds.find((g) => g.id === 'newborn');
const runToBoundary = (s) => { do { s = tick(s); } while (s.tick % s.windowN !== 0); return s; };

// The client's Fuel Δ denominator, mirrored EXACTLY (client/game.html standingPanel): the
// stamped cycle entitlement once a boundary has recorded one, else the founding baseline.
const chooseDenominator = (r) => (r.fuelGrant && r.fuelGrant.entitlement != null)
  ? r.fuelGrant.entitlement
  : (r.foundingEntitlement != null ? r.foundingEntitlement : null);
// …and the ratio the gauge draws (the one sanctioned derive), null ⇒ the gauge renders `—`.
const fuelDelta = (r) => {
  const cur = chooseDenominator(r);
  const nxt = r.predictedGrant != null ? r.predictedGrant : null;
  return (cur != null && cur > 0 && nxt != null) ? nxt / cur : null;
};

// --- 1. the stamp itself ----------------------------------------------------------

test('founding stamps foundingEntitlement = grantFor(state, guild), an integer credit', () => {
  const s = founded();
  const g = guild(s);
  assert.equal(g.foundingEntitlement, grantFor(s, g), 'the baseline IS grantFor at founding, captured not re-derived');
  // Pinned outright too, so the arithmetic is checkable by eye: a bare-founded guild holds its
  // home system alone (GP 200) and opens ON its line (modifier 1.0, via the endowment), so
  // grantFor = round(0.3 × 200 × 1.0) = 60.
  assert.equal(guildPoints(s, g), W_SYS, 'it holds its home system and nothing else');
  assert.equal(issuanceModifier(s, g), 1, 'and opens on its line');
  assert.equal(g.foundingEntitlement, Math.round(BASE_GRANT_PER_GP * W_SYS * 1), 'round(BASE_GRANT_PER_GP × GP × modifier)');
  assert.equal(g.foundingEntitlement, 60);
  assert.ok(Number.isInteger(g.foundingEntitlement) && g.foundingEntitlement > 0);
  // The honest-baseline guarantee: it stamped NO grant record — the boundary machinery never
  // sees a phantom grant that did not happen.
  assert.equal(g.lastFuelGrant, undefined, 'no synthesised grant record — a pure baseline');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'and the freshly-founded state is invariant-clean');
});

test('at founding the gauge reads exactly ×1.00 — predictedGrant equals the baseline', () => {
  // predictedGrant and foundingEntitlement are computed from ONE GP and modifier at founding,
  // so the client's ratio opens at exactly ×1.00 (not `—`), before any boundary.
  const r = row(founded());
  assert.equal(r.foundingEntitlement, 60, 'the baseline is published on the row…');
  assert.equal(r.predictedGrant, r.foundingEntitlement, '…and equals the live entitlement at founding');
  assert.equal(r.fuelGrant, null, 'with no cycle-boundary record yet');
  assert.equal(chooseDenominator(r), 60, 'so the denominator falls back to the founding baseline');
  assert.equal(fuelDelta(r), 1, 'and the gauge opens at exactly ×1.00 — live from tick 0, not —');
});

// --- 2. it swings live as the guild grows this cycle ------------------------------

test('as the guild grows within the cycle, the ratio climbs above ×1.00 (baseline held)', () => {
  // Grow the guild's standing WITHOUT crossing a boundary: establish a venture (GP 200 → 300)
  // and lift its reputation so the modifier rises above founding. predictedGrant climbs while
  // foundingEntitlement is unmoved (stamped at founding) — the gauge swings green.
  let s = founded();
  const baseline = guild(s).foundingEntitlement;
  s = applyValid(s, createEstablishVentureAction({
    guildId: 'newborn', ventureId: 'm1', siteId: HOME_MINE,
    assetId: 'asset_newborn_miner_01', resourceType: 'titanium', productionRate: 10,
  }));
  // Lift reputation, keeping the guild total exact (checkGuildReputationSum): the venture earns
  // RP, the guild total moves with it — the modifier rises to its ceiling.
  s.guilds[0].ventures[0].reputation = 200;
  s.guilds[0].guildReputation += 200;

  const r = row(s);
  assert.equal(r.foundingEntitlement, baseline, 'the founding baseline is UNMOVED — set once at founding');
  assert.ok(r.predictedGrant > r.foundingEntitlement, 'the live entitlement has climbed above it');
  assert.equal(chooseDenominator(r), baseline, 'the denominator is still the founding baseline (no boundary yet)');
  assert.ok(fuelDelta(r) > 1, 'so the gauge reads above ×1.00 — this cycle is growing the guild\'s fuel');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'and the grown state is invariant-clean');
});

// --- 3. the first boundary rebases the denominator onto the stamped entitlement ---

test('after the first boundary, fuelGrant.entitlement takes over the denominator', () => {
  // A bare-founded guild (GP 200) is due a grant, so its first boundary records a real
  // `fuelGrant.entitlement`. From then on the client picks it over the founding baseline —
  // the gauge rebases, exactly today's post-Slice-D behaviour.
  let s = founded();
  const beforeRow = row(s);
  assert.equal(chooseDenominator(beforeRow), beforeRow.foundingEntitlement, 'before: the baseline is the denominator');

  s = runToBoundary(s);
  const g = guild(s);
  assert.ok(g.lastFuelGrant, 'the boundary recorded a grant');
  assert.equal(typeof g.lastFuelGrant.entitlement, 'number', 'which carries this cycle\'s entitlement');

  const r = row(s);
  assert.notEqual(r.fuelGrant, null, 'the snapshot now carries the grant record');
  assert.notEqual(r.foundingEntitlement, null, 'the founding baseline is still published (never cleared)…');
  // The denominator now SOURCES from the stamped entitlement, not the baseline. For an idle
  // guild the two values coincide (its modifier held at 1.0 across the boundary), so the switch
  // is proven by SOURCE: the picker reads `fuelGrant.entitlement` whenever the record exists,
  // and only falls back to the baseline when it does not.
  assert.equal(chooseDenominator(r), r.fuelGrant.entitlement, '…and the denominator is the stamped entitlement');
  const withoutRecord = { ...r, fuelGrant: null };
  assert.equal(chooseDenominator(withoutRecord), r.foundingEntitlement,
    'the baseline is the fallback ONLY when there is no record — so the record takes precedence');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- 4. no baseline ⇒ the gauge honestly reads — (no divide-by-zero) --------------

test('a guild with no baseline reads null ⇒ the gauge renders — (never a divide-by-zero)', () => {
  // A guild NOT founded through `foundGuild` (a scenario/test one) carries no baseline and no
  // grant record: the snapshot reports null and the ratio is null, so the gauge draws `—`.
  const snap = buildSnapshot(createState({
    guilds: [{ id: 'scenario', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  }));
  const r = snap.guilds[0];
  assert.equal(r.foundingEntitlement, null, 'never founded, so never a baseline');
  assert.equal(r.fuelGrant, null, 'and no grant record');
  assert.equal(chooseDenominator(r), null, 'the denominator is genuinely null…');
  assert.equal(fuelDelta(r), null, '…so the gauge reads — rather than dividing by nothing');

  // And the arithmetic reason the founding guard omits a zero: a GP-0 guild is due nothing, so
  // grantFor is 0 — the `if (foundingEntitlement !== 0)` guard in the apply leaves no key, the
  // same null. (A real founding always holds a home system, so this branch is only reachable
  // in principle — but the guard is honest about it rather than stamping a meaningless 0.)
  const zs = createState({
    guilds: [{ id: 'z', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 }, syndicate: { ledger: 0 },
  });
  assert.equal(grantFor(zs, zs.guilds[0]), 0, 'a zero-GP guild draws nothing, so its baseline would be omitted');
});

// --- 5. serialisation & determinism -----------------------------------------------

test('the field is OMITTED when absent, so an unfounded guild is byte-identical', () => {
  const s = createState({
    guilds: [{ id: 'scenario', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(s.guilds[0], 'foundingEntitlement'), false);
  assert.equal(canonicalStringify(s).includes('foundingEntitlement'), false,
    'the string appears nowhere in a scenario-built galaxy — which is why those goldens did not move');

  // …but a value handed in is CARRIED, not silently dropped (a restored save must keep it).
  const carried = createState({
    guilds: [{ id: 'restored', credits: 0, fuelHoard: 0, ventures: [], foundingEntitlement: 60 }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  assert.equal(carried.guilds[0].foundingEntitlement, 60);
});

test('a founded guild ROUND-TRIPS through serialisation with its baseline intact', () => {
  const restored = JSON.parse(canonicalStringify(founded()));
  const g = restored.guilds.find((x) => x.id === 'newborn');
  assert.equal(g.foundingEntitlement, 60);
  assert.deepEqual(checkInvariants(restored, restored.tick), [], 'and the state is clean after a reload');
});

// --- 6. the snapshot surface ------------------------------------------------------

test('the snapshot publishes the baseline, and reports null for an unfounded guild', () => {
  assert.equal(row(founded()).foundingEntitlement, 60, 'a founded guild carries it');
  assert.equal(buildSnapshot(founded()).schemaVersion, 7, 'additive — no schema bump');
  const scenario = buildSnapshot(createState({
    guilds: [{ id: 'scenario', credits: 0, fuelHoard: 0, ventures: [] }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  }));
  assert.equal(scenario.guilds[0].foundingEntitlement, null, 'a null, not an absence');
});
