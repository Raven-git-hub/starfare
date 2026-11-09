'use strict';

// droid-autoreplace.test.js — roadmap 2.6, droid client slice 2: AUTO-REPLACE (docs/droids.md §13.2).
//
// The tripwires, in order:
//   1. NO-OP BYTE-IDENTICAL: with `autoReplace` off everywhere — droids deployed, droids dying, a week boundary
//      crossed — the galaxy hashes exactly as it did at ef14e01, before this slice (RE-PINNED 09-11-26 for the
//      maintenance slice 1 droid retune, which deliberately changes droid wear — see the note at the golden).
//   2. THE ACTION: setAutoReplace's refusals; on writes `autoReplace: true`, off REMOVES the key; tick-stamped.
//   3. THE SOURCE RULE: a Syndicate death refills Syndicate-only (empty if none, never guild); a guild death
//      prefers guild and falls back to Syndicate; lowest id within a source.
//   4. THE TWO-PASS FILL: one idle Syndicate spare, a guild death and a Syndicate death the same tick — the
//      Syndicate vacancy gets it, even though the guild vacancy comes first in venture order.
//   5. THE GATE: a Syndicate vacancy on a lapsed-licence venture stays empty; a spare in another system is never
//      used; the cap holds (one death → at most one refill).
//   6. NO FREE REPAIR: a worn spare deploys at its own condition.
//   7. DEATH-ONLY: an unassign on an auto-replace venture is never refilled.
//   8. NEUTRALITY (invariant 2): a refill moves no credit, good, fuel, GP or RP — only the droid's assignment.
//   9. DETERMINISM (invariant 9): two runs, and a save/restore, are byte-identical.
//  10. SNAPSHOT: the flag is published on the owner's venture row, omitted when off, fogged from rivals.
//  11. THE NEW INVARIANT bites.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createState } = require('../state.js');
const { advance } = require('../run.js');
const { stepDroidUpkeep } = require('../tick.js');
const { hashState } = require('../serialize.js');
const { saveState, loadOrInit } = require('../persist.js');
const { checkInvariants } = require('../invariants.js');
const { buildSnapshot } = require('../snapshot.js');
const { guildPoints } = require('../points.js');
const { expectedReputation } = require('../meanline.js');
const {
  DROID_CAP, DROID_WEAR_SCALE, wearPerTick, refillAutoReplaceVacancies, fundDroidUpkeep, byDroidId,
} = require('../droids.js');
const {
  validateAction, applyAction, intake, createSetAutoReplaceAction, createUnassignDroidAction,
  createApplyForLicenceAction,
} = require('../actions.js');
const { autoReplaceOffScript } = require('./droid-autoreplace-noop-script.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const WEEK = 10_080;
const idFor = (n) => `asset_g1_droid_${String(n).padStart(2, '0')}`;

// A droid with exactly ONE tick of (unmaintained) life left: it reaches 0 on the next tick.
const LAST_TICK = (source) => wearPerTick(source, false) / DROID_WEAR_SCALE;

// droid(n, source, opts) -> a droid row. Deployed to `ventureId` unless `idle`; `dying` sets it to die next tick.
function droid(n, source, { ventureId, idle = false, dying = false, condition = 1, systemId = SYS } = {}) {
  return {
    id: idFor(n), systemId, source, condition: dying ? LAST_TICK(source) : condition, updatedAtTick: 0,
    ...(idle ? {} : { assignedToVentureId: ventureId, deployedAtTick: 0 }),
  };
}
const mine = (id, { autoReplace = false, good = 'titanium', systemId = SYS } = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: good, productionRate: 5,
  ...(autoReplace ? { autoReplace: true } : {}),
});

// galaxy({ ventures, droids, licensed, tick }) -> one guild (plus optional rivals), with the named ventures
// licensed through the real applyForLicence action, and every invariant checked before it is returned.
function galaxy({ ventures, droids, licensed = [], tick = 100, extraGuilds = [] }) {
  let s = createState({
    guilds: [{
      id: 'g1', credits: 100_000, fuelHoard: 0, stockpiles: { [SYS]: { droid_components: 0 } }, ventures,
      droids, droidSerial: Math.max(...droids.map((d) => Number(d.id.split('_').pop()))),
    }, ...extraGuilds],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
  });
  s.tick = tick;
  if (licensed.length) {
    const out = intake(s, licensed.map((ventureId) => (
      createApplyForLicenceAction({ guildId: 'g1', ventureId, committedOutputPct: 0.5, windowDays: 7 })
    )));
    for (const r of out.results) assert.ok(r.accepted, r.reason);
    s = out.state;
  }
  assert.deepEqual(checkInvariants(s, s.tick), [], 'the fixture itself is legal');
  return s;
}
function run(s, n) {
  let out = s;
  for (let i = 0; i < n; i += 1) out = advance(out).state;
  return out;
}
const g1Of = (s) => s.guilds[0];
const droidOf = (s, n) => (g1Of(s).droids || []).find((d) => d.id === idFor(n));
const ventureOf = (s, n) => (droidOf(s, n) || {}).assignedToVentureId;
const crewOf = (s, ventureId) => (g1Of(s).droids || []).filter((d) => d.assignedToVentureId === ventureId).map((d) => d.id);
function accept(s, action) {
  const { valid, reason } = validateAction(s, action);
  assert.equal(valid, true, `expected ${action.type} accepted, got: ${reason}`);
  const next = applyAction(s, action);
  assert.deepEqual(checkInvariants(next, next.tick), []);
  return next;
}

// --- 1. no-op byte-identical --------------------------------------------------------------------------------

// RECORDED AT ef14e01 (main, before this slice's code existed) by running droid-autoreplace-noop-script.js there:
// both sources deployed and three of them wearing out mid-run, idle spares of both sources beside them, a licensed
// venture, a week boundary crossed — and `autoReplace` on nowhere. If this moves, the slice changed behaviour for
// a galaxy that never switched it on.
//
// RE-PINNED 09-11-26 — maintenance slice 1 (docs/maintenance.md §1), a DELIBERATE change. The ef14e01 hash was
// d9ff1eef97f0f8365c508aff365d29a93c56c0218ce621c7a3e34aa123e2d43c. The script is unchanged; the droid numbers it
// runs on are not. At the week boundary the 3 droid_components now cover THREE droids at 1 each (they covered
// two when a Syndicate droid cost 2), and a maintained guild droid now wears 1 unit a tick on a 161,280 scale
// (×4 life) instead of 1 on 80,640 (×2). So guild droid 02 on m_lic, which died at tick 10,101 under the old
// numbers, is still alive at the end of the run (11 units left): 2 droids_spent notices, not 3. Diffing the two
// end states field by field (main at dfb1e67 vs this slice), EVERY changed path follows from that one droid
// living on: g1's droids / events / eventSeq; its still-boosted production (productionHistory, the two ventures'
// extractionCarry); the extra titanium the licensed venture delivered (syndicateWindows delivered / sendCarry) and
// the 1 credit it moved from the Syndicate ledger to the guild (credits 99,823 → 99,824, ledger 177 → 176 —
// conserved); and copper's price (prices, priceRing, priceHistory) answering the boosted supply. Nothing else
// moved — no fuel, no GP, no other guild. The auto-replace code is untouched, so the no-op guard it was written for
// holds from this pin on.
const AUTOREPLACE_OFF_GOLDEN_RETUNE = 'b92c92f35cdb276bdc7688306dbd483099d2ca1d475c0dfe22a3c58bad4d4d64';

test('no-op: with autoReplace off everywhere, deaths across a week boundary are byte-identical to the pin', () => {
  const s = autoReplaceOffScript();
  const g = g1Of(s);
  // 2 since the 09-11-26 retune (was 3 — see the note above): a maintained guild droid now lasts twice as long.
  assert.equal(g.events.filter((e) => e.type === 'droids_spent').length, 2, 'the run really did destroy droids');
  assert.ok(g.droids.filter((d) => d.assignedToVentureId === undefined).length >= 3, 'and the spares were left idle');
  assert.ok(g.ventures.every((v) => !('autoReplace' in v)), 'no venture carries the key');
  assert.equal(hashState(s), AUTOREPLACE_OFF_GOLDEN_RETUNE);
});

// --- 2. the action ------------------------------------------------------------------------------------------

test('setAutoReplace: on writes true, off removes the key, each stamped with the tick; nothing else moves', () => {
  let s = galaxy({ ventures: [mine('m')], droids: [droid(1, 'guild', { idle: true })] });
  const before = structuredClone(s);
  s = accept(s, createSetAutoReplaceAction({ guildId: 'g1', ventureId: 'm', on: true }));
  assert.equal(g1Of(s).ventures[0].autoReplace, true);
  assert.equal(g1Of(s).ventures[0].updatedAtTick, s.tick, 'the venture records the tick (§15.2)');
  assert.deepEqual(g1Of(s).droids, g1Of(before).droids, 'switching it on moves no droid');
  assert.equal(g1Of(s).credits, g1Of(before).credits);
  s = accept(s, createSetAutoReplaceAction({ guildId: 'g1', ventureId: 'm', on: false }));
  assert.equal('autoReplace' in g1Of(s).ventures[0], false, 'off is the ABSENT key, never false');
});

test('setAutoReplace refusals: no guild, not your venture, a rival\'s venture, a non-boolean `on`', () => {
  const rival = {
    id: 'g2', credits: 0, fuelHoard: 0,
    ventures: [{ id: 'r', ownerGuildId: 'g2', type: 'mining', systemId: SYS_B, resourceType: 'copper', productionRate: 1 }],
  };
  const s = galaxy({ ventures: [mine('m')], droids: [droid(1, 'guild', { idle: true })], extraGuilds: [rival] });
  const refused = (a) => validateAction(s, { type: 'setAutoReplace', ...a });
  assert.match(refused({ guildId: 'gX', ventureId: 'm', on: true }).reason, /no guild/);
  assert.match(refused({ guildId: 'g1', ventureId: 'nope', on: true }).reason, /owns no venture/);
  assert.match(refused({ guildId: 'g1', ventureId: 'r', on: true }).reason, /owns no venture/);
  assert.match(refused({ guildId: 'g1', ventureId: 'm', on: 'yes' }).reason, /true or false/);
  assert.match(refused({ guildId: 'g1', ventureId: 'm' }).reason, /true or false/);
  assert.throws(() => createSetAutoReplaceAction({ guildId: 'g1', ventureId: 'm' }), /on is required/);
});

// --- 3. the source rule -------------------------------------------------------------------------------------

test('a Syndicate death refills with the lowest-id idle Syndicate droid — never a guild one, even a lower id', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    licensed: ['m'],
    droids: [
      droid(1, 'syndicate', { ventureId: 'm', dying: true }),
      droid(2, 'guild', { idle: true }),
      droid(4, 'syndicate', { idle: true }),
      droid(3, 'syndicate', { idle: true }),
    ],
  }), 1);
  assert.equal(droidOf(s, 1), undefined, 'the worn-out droid is gone');
  assert.equal(ventureOf(s, 3), 'm', 'the lowest-id Syndicate spare took the slot');
  assert.equal(ventureOf(s, 4), undefined);
  assert.equal(ventureOf(s, 2), undefined, 'the guild spare was not touched');
  assert.equal(droidOf(s, 3).deployedAtTick, s.tick, 'stamped with the tick it was placed');
  assert.equal(droidOf(s, 3).updatedAtTick, s.tick);
  assert.equal(droidOf(s, 3).maintained, undefined, 'a refill is unmaintained until the next week boundary');
});

test('a Syndicate death with only guild spares stays EMPTY — auto-replace never upgrades to guild', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    licensed: ['m'],
    droids: [droid(1, 'syndicate', { ventureId: 'm', dying: true }), droid(2, 'guild', { idle: true })],
  }), 1);
  assert.deepEqual(crewOf(s, 'm'), []);
  assert.equal(ventureOf(s, 2), undefined);
});

test('a guild death prefers a guild spare, even over a lower-id Syndicate one', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    licensed: ['m'],
    droids: [
      droid(1, 'guild', { ventureId: 'm', dying: true }),
      droid(2, 'syndicate', { idle: true }),
      droid(3, 'guild', { idle: true }),
    ],
  }), 1);
  assert.equal(ventureOf(s, 3), 'm');
  assert.equal(ventureOf(s, 2), undefined);
});

test('a guild death with no guild spare FALLS BACK to the lowest-id Syndicate spare the gate allows', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    licensed: ['m'],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(5, 'syndicate', { idle: true }), droid(2, 'syndicate', { idle: true })],
  }), 1);
  assert.equal(ventureOf(s, 2), 'm');
  assert.equal(ventureOf(s, 5), undefined);
});

test('a guild death on an UNLICENSED venture with only Syndicate spares stays empty — the gate refuses them', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(2, 'syndicate', { idle: true })],
  }), 1);
  assert.deepEqual(crewOf(s, 'm'), []);
});

test('"lowest id" is the LEXICOGRAPHIC order of the id string: droid_100 is chosen before droid_99', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(99, 'guild', { idle: true }), droid(100, 'guild', { idle: true })],
  }), 1);
  assert.equal(ventureOf(s, 100), 'm', "'…droid_100' < '…droid_99' as strings — the shipped convention (§13.2)");
  assert.equal(ventureOf(s, 99), undefined);
});

test('one order: the refill and the §5 maintenance triage pick the SAME droid past serial 99, and the snapshot agrees', () => {
  // byDroidId is lexicographic: it agrees with mint order through 99 and departs from it at 100.
  const ids = (ns) => ns.map((n) => ({ id: idFor(n) })).sort(byDroidId).map((d) => d.id);
  assert.deepEqual(ids([12, 3, 7]), [idFor(3), idFor(7), idFor(12)], 'agrees with number order through 99');
  assert.deepEqual(ids([99, 100, 101, 9]), [idFor(9), idFor(100), idFor(101), idFor(99)], "string order past it ('09' < '100' < '101' < '99')");

  // The refill's pick among idle 99 / 100 / 101 …
  const refilled = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(99, 'guild', { idle: true }),
      droid(101, 'guild', { idle: true }), droid(100, 'guild', { idle: true })],
  }), 1);
  const refillPick = (g1Of(refilled).droids.find((d) => d.assignedToVentureId === 'm') || {}).id;
  // … and the triage's pick among deployed 99 / 100 / 101 at EQUAL condition, with stock for only one: the id
  // tie-break alone decides which is maintained.
  const triage = galaxy({
    ventures: [mine('m')],
    droids: [droid(99, 'guild', { ventureId: 'm' }), droid(101, 'guild', { ventureId: 'm' }), droid(100, 'guild', { ventureId: 'm' })],
  });
  g1Of(triage).stockpiles[SYS].droid_components = 1;
  fundDroidUpkeep(g1Of(triage), SYS, triage.tick);
  const triagePick = g1Of(triage).droids.filter((d) => d.maintained).map((d) => d.id);
  assert.equal(refillPick, idFor(100));
  assert.deepEqual(triagePick, [refillPick], 'the triage and the refill agree on the lowest id');
  // The snapshot (which the client's Deploy reads) lists the guild's droids in the same order.
  const snapIds = buildSnapshot(triage, 'g1').guilds.find((g) => g.id === 'g1').droids.map((d) => d.id);
  assert.deepEqual(snapIds, ids([99, 100, 101]), 'the snapshot sorts droids by the same order');
});

// --- 4. the two-pass fill -----------------------------------------------------------------------------------

test('two-pass: a guild fallback never takes the Syndicate spare a Syndicate vacancy needs', () => {
  // `a` comes FIRST in venture order and loses a GUILD droid; `b` loses a SYNDICATE droid. One Syndicate spare.
  // A single in-order pass would hand it to `a`'s fallback and leave `b` empty; the two passes give it to `b`.
  const s = run(galaxy({
    ventures: [mine('a', { autoReplace: true }), mine('b', { autoReplace: true, good: 'copper' })],
    licensed: ['a', 'b'],
    droids: [
      droid(1, 'guild', { ventureId: 'a', dying: true }),
      droid(2, 'syndicate', { ventureId: 'b', dying: true }),
      droid(3, 'syndicate', { idle: true }),
    ],
  }), 1);
  assert.equal(ventureOf(s, 3), 'b', 'the genuine Syndicate vacancy is served first');
  assert.deepEqual(crewOf(s, 'a'), [], 'the guild vacancy found no fallback left and stays empty');
});

test('two-pass: several deaths, a mixed buffer — own sources first in venture order, then the fallbacks', () => {
  const s = run(galaxy({
    ventures: [mine('a', { autoReplace: true }), mine('b', { autoReplace: true, good: 'copper' })],
    licensed: ['a', 'b'],
    droids: [
      droid(1, 'guild', { ventureId: 'a', dying: true }),
      droid(2, 'guild', { ventureId: 'a', dying: true }),
      droid(3, 'syndicate', { ventureId: 'b', dying: true }),
      droid(4, 'guild', { ventureId: 'b', dying: true }),
      droid(10, 'guild', { idle: true }),
      droid(11, 'syndicate', { idle: true }),
      droid(12, 'syndicate', { idle: true }),
    ],
  }), 1);
  // Pass 1: a's two guild vacancies → only droid 10 (a's first); b's Syndicate → 11; b's guild → none left.
  // Pass 2: a's second guild vacancy (earlier in venture order) → 12; b's guild vacancy → nothing left.
  assert.deepEqual(crewOf(s, 'a').sort(), [idFor(10), idFor(12)]);
  assert.deepEqual(crewOf(s, 'b'), [idFor(11)]);
});

test('only auto-replace ventures are refilled — a death on a venture with it off leaves its slot empty', () => {
  const s = run(galaxy({
    ventures: [mine('off'), mine('on', { autoReplace: true, good: 'copper' })],
    droids: [
      droid(1, 'guild', { ventureId: 'off', dying: true }),
      droid(2, 'guild', { ventureId: 'on', dying: true }),
      droid(3, 'guild', { idle: true }),
    ],
  }), 1);
  assert.deepEqual(crewOf(s, 'off'), []);
  assert.deepEqual(crewOf(s, 'on'), [idFor(3)]);
});

// --- 5. the gate --------------------------------------------------------------------------------------------

test('licence lapse: a Syndicate vacancy on a now-unlicensed venture stays empty; its guild deaths still refill', () => {
  // A hand-built venture with Syndicate droids but NO licence is exactly a lapsed one: the droids stay (the gate is
  // assign-time only), but a new Syndicate droid cannot go on.
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [
      droid(1, 'syndicate', { ventureId: 'm', dying: true }),
      droid(2, 'guild', { ventureId: 'm', dying: true }),
      droid(3, 'syndicate', { ventureId: 'm' }),
      droid(4, 'syndicate', { idle: true }),
      droid(5, 'guild', { idle: true }),
    ],
  }), 1);
  assert.deepEqual(crewOf(s, 'm').sort(), [idFor(3), idFor(5)], 'the guild death refilled with guild; the Syndicate one eroded');
  assert.equal(ventureOf(s, 4), undefined, 'the Syndicate spare was refused by the gate');
});

test('same system only: a spare in another system is never used', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true }), mine('far', { systemId: SYS_B, good: 'copper' })],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(2, 'guild', { idle: true, systemId: SYS_B })],
  }), 1);
  assert.deepEqual(crewOf(s, 'm'), []);
  assert.equal(ventureOf(s, 2), undefined);
});

test('cap: one death frees one slot and at most one refill fills it — a full venture stays at exactly CAP', () => {
  const crew = Array.from({ length: DROID_CAP }, (_, i) => droid(i + 1, 'guild', { ventureId: 'm', dying: i === 0 }));
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [...crew, droid(21, 'guild', { idle: true }), droid(22, 'guild', { idle: true })],
  }), 1);
  assert.equal(crewOf(s, 'm').length, DROID_CAP);
  assert.equal(ventureOf(s, 21), 'm');
  assert.equal(ventureOf(s, 22), undefined, 'the second spare stays idle');
});

// --- 6. no free repair --------------------------------------------------------------------------------------

test('no free repair: a worn spare deploys at its OWN condition, not full', () => {
  const s = run(galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(2, 'guild', { idle: true, condition: 0.4 })],
  }), 1);
  assert.equal(ventureOf(s, 2), 'm');
  assert.equal(droidOf(s, 2).condition, 0.4, 'placed this tick, after the wear — exactly as it stood idle');
  const later = run(s, 1);
  assert.ok(droidOf(later, 2).condition < 0.4, 'and from the next tick it wears from there');
});

// --- 7. death-only ------------------------------------------------------------------------------------------

test('death-only: a player unassign on an auto-replace venture is never refilled', () => {
  let s = galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { ventureId: 'm' }), droid(2, 'guild', { idle: true })],
  });
  s = accept(s, createUnassignDroidAction({ guildId: 'g1', droidId: idFor(1) }));
  s = run(s, 3);
  assert.deepEqual(crewOf(s, 'm'), [], 'the slot the player emptied stays empty');
  assert.equal(ventureOf(s, 2), undefined);
});

test('death-only: the refill reads only the spent droids — nothing spent, nothing filled', () => {
  const s = galaxy({
    ventures: [mine('m', { autoReplace: true })],
    droids: [droid(1, 'guild', { idle: true })],
  });
  assert.deepEqual(refillAutoReplaceVacancies(g1Of(s), SYS, [], s.tick + 1), []);
  assert.equal(ventureOf(s, 1), undefined);
});

// --- 8. neutrality ------------------------------------------------------------------------------------------

// strip(state) -> the state with the droid rows and the event log removed: what must NOT move in a refill tick.
function strip(st) {
  const c = structuredClone(st);
  for (const g of c.guilds) { delete g.droids; delete g.events; delete g.eventSeq; }
  return c;
}

test('neutrality (invariant 2): a refill moves no credit, good, fuel, GP or RP — only the droid\'s assignment', () => {
  const s = galaxy({
    ventures: [mine('m', { autoReplace: true })],
    licensed: ['m'],
    droids: [droid(1, 'guild', { ventureId: 'm', dying: true }), droid(2, 'syndicate', { idle: true, condition: 0.7 })],
  });
  const before = structuredClone(s);
  const spare = structuredClone(droidOf(s, 2));
  stepDroidUpkeep(s, g1Of(s), SYS);
  assert.equal(ventureOf(s, 2), 'm', 'the fallback refilled the slot');
  assert.deepEqual(strip(s), strip(before), 'nothing outside the droid rows and the notice moved');
  assert.deepEqual(guildPoints(s, 'g1'), guildPoints(before, 'g1'), 'no GP');
  assert.deepEqual(expectedReputation(s, 'g1'), expectedReputation(before, 'g1'), 'no RP');
  // The spare itself changed only in its assignment pair and its stamp — its condition and source are its own.
  const after = droidOf(s, 2);
  assert.deepEqual(
    { ...after, assignedToVentureId: undefined, deployedAtTick: undefined, updatedAtTick: undefined },
    { ...spare, assignedToVentureId: undefined, deployedAtTick: undefined, updatedAtTick: undefined },
  );
});

// --- 9. determinism -----------------------------------------------------------------------------------------

function competitionRun(n) {
  return run(galaxy({
    ventures: [mine('a', { autoReplace: true }), mine('b', { autoReplace: true, good: 'copper' })],
    licensed: ['a', 'b'],
    droids: [
      droid(1, 'guild', { ventureId: 'a', condition: 0.0004 }),
      droid(2, 'syndicate', { ventureId: 'b', condition: 0.0003 }),
      droid(3, 'syndicate', { ventureId: 'a', condition: 0.0005 }),
      droid(4, 'guild', { ventureId: 'b' }),
      droid(5, 'syndicate', { idle: true }),
      droid(6, 'guild', { idle: true, condition: 0.2 }),
    ],
    tick: WEEK - 30,
  }), n);
}

test('determinism (invariant 9): the two-pass fill across deaths and a week boundary is byte-identical twice', () => {
  const a = competitionRun(60);
  assert.ok(g1Of(a).events.some((e) => e.type === 'droids_spent'), 'droids died');
  assert.ok([5, 6].every((n) => ventureOf(a, n) !== undefined), 'and the spares were placed');
  assert.equal(hashState(a), hashState(competitionRun(60)));
});

test('determinism (invariant 9): a save/restore mid-run continues byte-identically, the flag included', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-autoreplace-'));
  try {
    const mid = competitionRun(5);
    saveState(mid, dir);
    const restored = loadOrInit(dir, () => { throw new Error('should restore, not init'); });
    assert.equal(g1Of(restored).ventures[0].autoReplace, true, 'the flag survives the save');
    assert.equal(hashState(restored), hashState(mid));
    assert.equal(hashState(run(restored, 55)), hashState(competitionRun(60)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 10. snapshot -------------------------------------------------------------------------------------------

test('snapshot: autoReplace is published on the owner\'s venture row, omitted when off, fogged from a rival', () => {
  const rival = { id: 'g2', credits: 0, fuelHoard: 0 };
  const s = galaxy({
    ventures: [mine('on', { autoReplace: true }), mine('off', { good: 'copper' })],
    licensed: ['on'],
    droids: [droid(1, 'guild', { idle: true })],
    extraGuilds: [rival],
  });
  const own = buildSnapshot(s, 'g1').ventures;
  assert.equal(own.find((v) => v.id === 'on').autoReplace, true);
  assert.equal('autoReplace' in own.find((v) => v.id === 'off'), false, 'omitted when off');
  const seen = buildSnapshot(s, 'g2').ventures.find((v) => v.id === 'on');
  assert.ok(seen, 'the rival sees the licensed venture on the public register');
  assert.equal('autoReplace' in seen, false, 'but not its auto-replace flag');
});

// --- 11. the invariant --------------------------------------------------------------------------------------

test('invariant: a stored autoReplace that is not exactly true halts', () => {
  const s = galaxy({ ventures: [mine('m')], droids: [droid(1, 'guild', { idle: true })] });
  g1Of(s).ventures[0].autoReplace = false;
  assert.ok(checkInvariants(s, s.tick).some((v) => v.rule.startsWith('venture-auto-replace-valid')));
});
