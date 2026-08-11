'use strict';

// Commitment-injection dev-scaffold layer — the runtime integration + no-op proofs
// for the two throwaway dev-scaffold actions (design.md §15.4 "Scaffold 11-08-26",
// §5; roadmap Phase 1 Stage 2 "injection-scaffold sub-slice"). The per-action unit
// checks live in actions.test.js; this file proves the actions WIRE THROUGH to the
// windowed engine (a set commitment lights a real Q and accrues over a window,
// resolving met/breach at the boundary; a set windowN moves the boundary cadence)
// and — the key guard — that a run touching NEITHER action is byte-identical to
// pre-change HEAD (the determinism-hash no-op proof).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const { intake, createSetSyndicateCommitmentAction, createSetWindowNAction } = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { hashState } = require('../serialize.js');
const { getWindow } = require('../windows.js');
const { previewProduction } = require('../production.js');

const SYS = 'sysA';
const mine = (id, good, rate, commitment = 0) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: good, productionRate: rate, syndicateCommitment: commitment,
});
const refinery = (id, recipeId, rate) => ({ id, ownerGuildId: 'g1', type: 'refining', systemId: SYS, recipeId, productionRate: rate });
const w = (s, good) => getWindow(s.guilds[0], SYS, good);
// The window telemetry the NEXT tick will produce (previewProduction previews
// producing tick state.tick + 1), the surface the client reads and computes nothing.
const nextWindow = (s, good) => previewProduction(s)[0].systems[0].goods[good].window;

function sysState(ventures, windowN) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN,
  });
}

// --- the actions wire through to a real windowed accrual ------------------------

test('a set commitment makes Q non-zero and the window accrues, resolving MET at the boundary', () => {
  // Start UNLICENSED (commitment 0, no windowN — a byte-identical zero-state). Then
  // inject via the scaffold actions: windowN=2, commitment=4 on a rate-10 mine ⇒
  // paced 2/tick ⇒ delivered reaches 4 = Q exactly at the boundary (tick 2) ⇒ met.
  let s = sysState([mine('t', 'titanium', 10, 0)]);
  assert.equal(s.windowN, undefined);

  const { state: injected, results } = intake(s, [
    createSetWindowNAction({ windowN: 2 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 4 }),
  ]);
  assert.deepEqual(results.map((r) => r.accepted), [true, true]);
  assert.equal(injected.windowN, 2);
  assert.equal(injected.guilds[0].ventures[0].syndicateCommitment, 4);
  // The injected venture still carries no committedFromTick — the fraction==1 guard.
  assert.equal('committedFromTick' in injected.guilds[0].ventures[0], false);
  // Q is now a real target the resolver sees (previewProduction reports it pre-tick).
  assert.equal(nextWindow(injected, 'titanium').Q, 4, 'Q = Σ commitment over the mines = 4');

  s = injected;
  s = tick(s); // producing tick 1: paced 2
  assert.equal(w(s, 'titanium').delivered, 2, 'accruing toward Q');
  assert.equal(nextWindow(s, 'titanium').status, 'met', 'the boundary tick (p=2) will meet Q');
  s = tick(s); // producing tick 2 = boundary
  assert.equal(w(s, 'titanium').delivered, 4, 'Q met at the boundary');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('an under-injected commitment BREACHES at the boundary (status flag only, no fee/credits)', () => {
  // commitment 9 over N=2 with a rate-4 mine: at most 4+4 = 8 fresh can be delivered,
  // short of Q 9 ⇒ breach. Credits/ledger never move (breach stays status-only).
  let s = sysState([mine('t', 'titanium', 4, 0)]);
  const creditsBefore = s.guilds[0].credits;
  const ledgerBefore = s.syndicate.ledger;
  ({ state: s } = intake(s, [
    createSetWindowNAction({ windowN: 2 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 9 }),
  ]));
  s = tick(s); // p=1
  assert.equal(nextWindow(s, 'titanium').status, 'breach', 'p=2 will fall short of Q ⇒ breach');
  s = tick(s); // p=2 boundary
  assert.equal(w(s, 'titanium').delivered, 8, 'only 8 delivered against Q 9 — a breach');
  assert.equal(s.guilds[0].credits, creditsBefore, 'breach touches no guild credits');
  assert.equal(s.syndicate.ledger, ledgerBefore, 'breach touches no ledger');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('the injected N moves the boundary cadence (the window rolls at tick % N == 0)', () => {
  // With windowN=3 injected, the boundary falls at tick 3 (the window's last), and a
  // new window-start is stamped at tick 4 — the cadence the new N sets (§5 tick % N).
  let s = sysState([mine('t', 'titanium', 10, 0)]);
  ({ state: s } = intake(s, [
    createSetWindowNAction({ windowN: 3 }),
    createSetSyndicateCommitmentAction({ guildId: 'g1', ventureId: 't', commitment: 6 }),
  ]));
  s = tick(s); // tick 1
  assert.equal(w(s, 'titanium').windowStart, 1);
  s = tick(s); // tick 2
  assert.equal(w(s, 'titanium').windowStart, 1, 'still in window 1 (2 % 3 != 0)');
  s = tick(s); // tick 3 = boundary (3 % 3 == 0)
  assert.equal(w(s, 'titanium').windowStart, 1, 'the boundary tick is the last tick of window 1');
  s = tick(s); // tick 4 = first tick of the next window
  assert.equal(w(s, 'titanium').windowStart, 4, 'a new window-start is stamped after the N-tick boundary');
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- the KEY no-op proof: a run touching NEITHER action is byte-identical to HEAD --

// Golden determinism hashes captured on the PRE-CHANGE engine (tick.js / state.js /
// production.js / windows.js — none of which this slice touches). The scaffold only
// ADDS action branches + a testbed control, so any run that calls neither action
// must reproduce these bytes exactly. If either hash drifts, the engine changed
// under this slice — which it must not (§5, §18: the unlicensed path stays untouched).
const GOLDEN_UNLICENSED = '682e42e0dd758ce523fea882f6560707802cdd7e7b4def794f323430a4cfcff5';
const GOLDEN_COMMITTED = 'd5896c9413cd5098eb141976f28a0e6e681e2c931f64c2fca1116c6aaff2e97d';

test('NO-OP PROOF: an unlicensed run (no scaffold action) is byte-identical to pre-change HEAD', () => {
  let s = sysState([mine('t', 'titanium', 10, 0), mine('c', 'carbon_products', 10, 0), refinery('r', 'titanium_alloy', 2)]);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  assert.equal(hashState(s), GOLDEN_UNLICENSED);
});

test('NO-OP PROOF: a committed run seeded via createVenture (not the action) matches pre-change HEAD', () => {
  // The commitment/windowN are fed in the OLD way (createVenture param + scenario
  // windowN), never through the new actions — so the windowed engine path is
  // exercised yet the bytes are identical to HEAD, proving the actions changed only
  // the intake surface, not the resolution.
  let s = sysState([mine('t', 'titanium', 10, 7), mine('c', 'carbon_products', 10, 5), refinery('r', 'titanium_alloy', 2)], 4);
  for (let i = 0; i < 40; i += 1) s = tick(s);
  assert.equal(hashState(s), GOLDEN_COMMITTED);
});
