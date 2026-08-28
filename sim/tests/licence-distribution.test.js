'use strict';

// licence-distribution.test.js — the licence DISTRIBUTION slice: met/breach is judged
// PER VENTURE, not per good (design.md §5, RULING 27-08-26).
//
// The engine tracks ONE aggregate window per (guild, system, good). That is still true —
// `delivered` stays a single accumulator. What this slice adds is the reading of it: at
// the boundary the good's whole delivered pile is filled down the player's `pursue`
// order, each licensed venture to its FULL target before the next is fed, and each then
// reads `met` (its entire target delivered) or `breach` (binary — one unit short is a
// breach). The good-level status becomes a ROLLUP of those verdicts.
//
// Three things here are load-bearing and each has its own test below:
//   (1) `Q = Σ qᵢ`, the per-venture targets rounded FIRST and then summed. Round-then-sum
//       and sum-then-round are different integers on fractional windows, and the fork
//       self-terminates at `Q` while the fill hands out `qᵢ` — so if they disagree a
//       venture can breach on a window whose pile was never allowed to reach its target.
//   (2) the fill is BINARY and PRIORITY-ORDERED — the top of the order is met in full
//       and the tail breaches, exactly as ranked.
//   (3) the fill draws on the WHOLE window pile with NO arrival-time fencing (the N-4
//       ruling): a high-ranked mid-window joiner may be met on units delivered before
//       its licence existed, and the venture that actually sent them then breaches.
//       That is the ruling, not a bug, and the test below asserts it as such.
//
// NOTHING IS CHARGED here. The per-venture status is computed and surfaced; 3b-iii is
// what reads it to debit a fee. The per-tick sale (Slice 3a) is untouched — it is the
// OTHER clock (proportional, per tick) and is deliberately not the pursue order.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { tick } = require('../tick.js');
const { createState } = require('../state.js');
const {
  intake, createApplyForLicenceAction, createSetProductionProfileAction,
} = require('../actions.js');
const { checkInvariants } = require('../invariants.js');
const { previewProduction, reviewSystem } = require('../production.js');
const { getWindow } = require('../windows.js');
const { MINE_BASELINE } = require('../baseline.js');
const { hashState } = require('../serialize.js');
const { buildSnapshot } = require('../snapshot.js');

const SYS = 'sysA';
const GOOD = 'titanium';
const N = 4;                          // a short window, so a mid-window join is a real fraction
const FULL_WINDOW_COMMITMENT = MINE_BASELINE[GOOD] * N;   // what pct = 1 buys: 20 units

const mine = (id, commitment, productionRate = 5) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId: SYS, resourceType: GOOD,
  productionRate, syndicateCommitment: commitment,
});

// A guild of mines on one good in one system. Commitments here are the DEV-SCAFFOLD
// shape (no `committedFromTick`), so every venture owes a FULL window — which is what
// makes the priority tests about the ORDER and nothing else.
function fixture(ventures) {
  return createState({
    guilds: [{ id: 'g1', credits: 0, fuelHoard: 0, ventures }],
    reserve: { reserveLevel: 0 },
    syndicate: { ledger: 0 },
    windowN: N,
  });
}

const guild = (s) => s.guilds[0];
const win = (s) => getWindow(guild(s), SYS, GOOD);
// The window telemetry for the tick that WOULD be resolved next — so read at
// `s.tick === N - 1` this is the BOUNDARY tick's verdict, its own send included.
const nextWindow = (s) => previewProduction(s)[0].systems[0].goods[GOOD].window;

// Pin the Syndicate send to a flat rate, so the pile at the boundary is an arithmetic
// fact of the fixture rather than whatever the paced default happens to converge on.
// (The paced default is very good at hitting `Q` exactly — which is the wrong thing for
// a test about how a SHORTFALL is distributed.)
const setSend = (s, value) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId: SYS, goods: { [GOOD]: { syndicate: { mode: 'absolute', value } } },
})]).state;

const setPursue = (s, pursue) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId: SYS, goods: { [GOOD]: { pursue } } },
)]).state;

// Run to one tick short of the boundary and return the boundary verdict.
const runToVerdict = (s) => {
  while (s.tick < N - 1) s = tick(s);
  return { state: s, verdict: nextWindow(s) };
};

const statuses = (w) => Object.fromEntries(
  Object.entries(w.perVenture).map(([id, r]) => [id, r.status]));

// --- (1) PRIORITY FILL ------------------------------------------------------------

test('a shortfall meets the TOP of the pursue order in full and breaches the tail', () => {
  // Two mines, one good, differing commitments: alpha owes 6, beta owes 4, so Q = 10.
  // The send is pinned to 2/tick over a 4-tick window ⇒ a pile of 8 against a 10 target.
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  const { state, verdict } = runToVerdict(s);

  assert.equal(verdict.Q, 10, 'Q = 6 + 4');
  assert.equal(verdict.delivered, 8, 'the pinned send delivers 8 of the 10');
  // Establishment order is the default ranking: alpha is fed to its full 6 FIRST, and
  // beta gets what is left — 2 of the 4 it owed.
  assert.deepEqual(verdict.perVenture, {
    alpha: { commitment: 6, delivered: 6, status: 'met' },
    beta: { commitment: 4, delivered: 2, status: 'breach' },
  });
  assert.deepEqual(checkInvariants(state, state.tick), []);
});

test('reordering `pursue` FLIPS the verdicts — same pile, same commitments', () => {
  // The identical run, with beta ranked first. Nothing about the goods changes: the
  // same 8 units are delivered by the same two mines. Only the ranking moves, and the
  // ranking is the whole difference between a discounted fee and a full one (3b-iii).
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  s = setPursue(s, ['beta', 'alpha']);
  const { state, verdict } = runToVerdict(s);

  assert.equal(verdict.delivered, 8, 'the same pile as the unranked run');
  assert.deepEqual(verdict.perVenture, {
    beta: { commitment: 4, delivered: 4, status: 'met' },
    alpha: { commitment: 6, delivered: 4, status: 'breach' },
  });
  assert.deepEqual(checkInvariants(state, state.tick), []);
});

test('the pile is handed out in full — Σ per-venture delivered = the good’s delivered', () => {
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  const { verdict } = runToVerdict(s);
  const sum = Object.values(verdict.perVenture).reduce((a, r) => a + r.delivered, 0);
  assert.equal(sum, verdict.delivered, 'the aggregate accumulator IS the sum of the shares');
});

// --- (2) BINARY -------------------------------------------------------------------

test('one unit short of its target is a BREACH, not a partial', () => {
  // alpha owes 5, beta owes 4 (Q = 9); the pinned send delivers 8. alpha is filled to
  // its 5 and beta gets 3 — exactly ONE unit short of the 4 it promised.
  let s = fixture([mine('alpha', 5), mine('beta', 4)]);
  s = setSend(s, 2);
  const { verdict } = runToVerdict(s);

  assert.equal(verdict.delivered, 8);
  assert.equal(verdict.perVenture.beta.delivered, 3);
  assert.equal(verdict.perVenture.beta.commitment, 4);
  assert.equal(verdict.perVenture.beta.status, 'breach',
    'one short is a breach — there is no partial-delivery credit (§5, binary)');
  assert.equal(verdict.perVenture.alpha.status, 'met');
});

test('mid-window a row SHORT of its target reads `accruing` — never an early breach', () => {
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  s = tick(s);                         // tick 1 — two ticks short of the boundary
  const w = nextWindow(s);             // previews tick 2, mid-window
  assert.equal(w.status, 'accruing');
  assert.deepEqual(statuses(w), { alpha: 'accruing', beta: 'accruing' },
    'the ranking is editable until the boundary, so an early BREACH would be a guess');
  assert.ok(w.perVenture.alpha.delivered > 0, 'but the projection off the delivered-so-far is real');
});

// --- (2b) the mid-window `met` refinement (console legibility pass, 28-08-26) -------
//
// `met` is the one verdict that is SAFE early: `delivered` only grows within a window,
// and the fill hands a licence its full `qi` before feeding the next, so a licence at
// its target cannot fall back below it. `breach` stays boundary-only — that one really
// is a fact about the window's end. Before this, a fully-delivered licence sat on the
// console's amber "still accruing" spinner for the rest of the day.

test('mid-window a licence already AT its target reads `met`, while a short one still accrues', () => {
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);   // Q = 10, boundary at tick 4
  s = setSend(s, 3);
  s = tick(s);                         // tick 1 — 3 delivered
  const w = nextWindow(s);             // previews tick 2: 6 delivered, still mid-window
  assert.equal(w.delivered, 6, 'two ticks at 3 units — 6 of Q 10, the window still running');
  assert.deepEqual(statuses(w), { alpha: 'met', beta: 'accruing' },
    'alpha has its whole 6: it is met NOW, not at the boundary. beta has nothing yet');
  assert.equal(w.perVenture.alpha.delivered, 6);
  assert.equal(w.status, 'accruing', 'the GOOD is still accruing — beta is not full');
});

test('the early `met` reaches no stored byte — status is telemetry, not state', () => {
  // The determinism guard for the refinement above. The stored window carries three
  // fields and none of them is a verdict, so moving WHEN `met` is reported cannot move
  // the hash. (The standing proof is the pinned golden in commitment-scaffold.test.js,
  // which runs a committed chain 40 ticks and is unchanged by this slice; this test
  // says WHY it is unchanged.)
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 5);
  s = tick(s);
  const before = hashState(s);
  const w = nextWindow(s);
  assert.equal(w.status, 'met', 'the preview really does report the early met');
  assert.deepEqual(Object.keys(win(s)).sort(), ['delivered', 'sendCarry', 'windowStart'],
    'the stored window holds accumulators only — no status, no perVenture');
  assert.equal(hashState(s), before, 'and reading the verdict moved nothing');
});

test('mid-window, once EVERY licence is full the good rolls up to `met` early too', () => {
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 5);
  s = tick(s);                         // tick 1 — 5 delivered
  const w = nextWindow(s);             // previews tick 2: the whole Q, mid-window
  assert.equal(w.delivered, 10, 'Q reached with two ticks of the window still to run');
  assert.deepEqual(statuses(w), { alpha: 'met', beta: 'met' });
  assert.equal(w.status, 'met', 'the pill agrees with the dots beneath it, as a rollup must');
});

// --- (3) THE F-C ROUNDING FIX: Q = Σ round, never round(Σ) -------------------------

test('F-C: Q is Σ of the ROUNDED per-venture targets, so a full pile meets everyone', () => {
  // Two mines licensed on the LAST tick of the window ⇒ each present 1 of 4 ticks, so
  // each owes `round(6 × ¼)` = round(1.5) = 2, and Q = 4.
  //
  // Sum-then-round would have made Q = round(1.5 + 1.5) = 3 — and the Syndicate fork
  // self-terminates at Q, so the pile could never exceed 3 while the fill hands out
  // 2 + 2. The second venture would breach on a window whose pile was never ALLOWED to
  // reach its target: a phantom breach, from an arithmetic disagreement alone.
  const PCT = 6 / FULL_WINDOW_COMMITMENT;                 // buys a commitment of 6
  let s = fixture([mine('alpha', 0), mine('beta', 0)]);
  while (s.tick < N - 1) s = tick(s);                     // …licence at tick 3 ⇒ stamped 4
  s = intake(s, [
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'alpha', committedOutputPct: PCT, windowDays: 7 }),
    createApplyForLicenceAction({ guildId: 'g1', ventureId: 'beta', committedOutputPct: PCT, windowDays: 7 }),
  ]).state;
  assert.equal(guild(s).ventures[0].syndicateCommitment, 6);
  assert.equal(guild(s).ventures[0].committedFromTick, N, 'present for the last tick only');

  const verdict = nextWindow(s);                          // the boundary tick
  assert.equal(Math.round(1.5) + Math.round(1.5), 4, 'Σ round');
  assert.equal(Math.round(1.5 + 1.5), 3, 'round(Σ) — the number this fixture rules out');
  assert.equal(verdict.Q, 4, 'the engine takes Σ round, so the pile may reach the targets');

  assert.equal(verdict.delivered, 4, 'and the mines can and do deliver all of it');
  assert.deepEqual(verdict.perVenture, {
    alpha: { commitment: 2, delivered: 2, status: 'met' },
    beta: { commitment: 2, delivered: 2, status: 'met' },
  }, 'full delivery meets EVERYONE — no phantom breach');
  assert.equal(verdict.status, 'met');

  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

// --- (4) THE N-4 RULING: the whole pile, no arrival-time fencing -------------------

test('N-4: a mid-window joiner ranked FIRST is met on units delivered before it existed', () => {
  // `early` is committed from the start and is the ONLY mine that produces anything.
  // `late` is licensed on tick 3 (stamped 4 — the window's last tick) and mines nothing
  // at all, so every unit in the pile is early's.
  //
  //   pile      = 2/tick × 4 ticks = 8
  //   early     owes 8 (full window)
  //   late      owes round(16 × ¼) = 4 — MORE than the 2 units delivered on the one
  //             tick it was actually present for.
  //
  // Ranked first, `late` is nonetheless MET: the fill draws on the WHOLE window pile,
  // including the 6 units delivered on ticks 1-3, before its licence existed. `early`,
  // which mined and delivered every one of those units, then breaches. This is the
  // RULING (§5, 27-08-26) — pursue is the lever for steering the goods you have onto
  // the licences that cost you least — and NOT a bug to be fenced by arrival time.
  const PCT = 16 / FULL_WINDOW_COMMITMENT;
  let s = fixture([mine('early', 8), mine('late', 0, 0)]);
  s = setSend(s, 2);
  s = setPursue(s, ['late', 'early']);

  let deliveredBeforeLateJoined = 0;
  while (s.tick < N - 1) {
    s = tick(s);
    deliveredBeforeLateJoined = win(s).delivered;
  }
  assert.equal(deliveredBeforeLateJoined, 6, 'six units are already in the pile…');

  s = intake(s, [createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'late', committedOutputPct: PCT, windowDays: 7,
  })]).state;
  assert.equal(guild(s).ventures[1].committedFromTick, N, '…when `late` is licensed, from the last tick');

  const verdict = nextWindow(s);
  assert.equal(verdict.Q, 12, '8 + round(16 × ¼)');
  assert.equal(verdict.delivered, 8);
  assert.equal(verdict.perVenture.late.commitment, 4);
  assert.ok(verdict.delivered - deliveredBeforeLateJoined < verdict.perVenture.late.commitment,
    'only 2 units arrive on the tick `late` was present for — fewer than the 4 it owes…');
  assert.equal(verdict.perVenture.late.status, 'met',
    '…and it is MET anyway: the fill is over the whole pile, unfenced by arrival time (N-4)');
  assert.deepEqual(verdict.perVenture.early, { commitment: 8, delivered: 4, status: 'breach' },
    'and the mine that actually sent every unit breaches — the ruled behaviour');

  s = tick(s);
  assert.deepEqual(checkInvariants(s, s.tick), []);
});

test('N-4: unranked, the same run meets the mine that did the work', () => {
  // The counterfactual to the test above, so it cannot be passing for another reason:
  // strip the ranking and establishment order feeds `early` first — it is met in full
  // and the latecomer gets nothing.
  const PCT = 16 / FULL_WINDOW_COMMITMENT;
  let s = fixture([mine('early', 8), mine('late', 0, 0)]);
  s = setSend(s, 2);
  while (s.tick < N - 1) s = tick(s);
  s = intake(s, [createApplyForLicenceAction({
    guildId: 'g1', ventureId: 'late', committedOutputPct: PCT, windowDays: 7,
  })]).state;

  const verdict = nextWindow(s);
  assert.deepEqual(verdict.perVenture, {
    early: { commitment: 8, delivered: 8, status: 'met' },
    late: { commitment: 4, delivered: 0, status: 'breach' },
  });
});

// --- (5) THE ROLLUP ---------------------------------------------------------------

test('the good-level status is a ROLLUP: all-met → met, any-breach → breach', () => {
  // Enough pile for everyone → every row met → the good reads met.
  let met = fixture([mine('alpha', 4), mine('beta', 4)]);
  met = setSend(met, 2);
  const metVerdict = runToVerdict(met).verdict;
  assert.deepEqual(statuses(metVerdict), { alpha: 'met', beta: 'met' });
  assert.equal(metVerdict.status, 'met', 'all met → met');

  // One short anywhere → the good reads breach, even though most of it was delivered.
  let mixed = fixture([mine('alpha', 6), mine('beta', 4)]);
  mixed = setSend(mixed, 2);
  const mixedVerdict = runToVerdict(mixed).verdict;
  assert.deepEqual(statuses(mixedVerdict), { alpha: 'met', beta: 'breach' });
  assert.equal(mixedVerdict.status, 'breach', 'any breach → breach');

  // …and it is derived FROM the rows, never the other way round: the rollup agrees with
  // the rows in every case, which is the property a future per-venture rule must keep.
  for (const w of [metVerdict, mixedVerdict]) {
    const allMet = Object.values(w.perVenture).every((r) => r.status === 'met');
    assert.equal(w.status, allMet ? 'met' : 'breach');
  }
});

// --- (6) READ-TIME RECONCILIATION -------------------------------------------------

test('a `pursue` entry naming a venture that no longer produces the good is IGNORED', () => {
  // The stored ranking is standing intent, reconciled at read time (like a throttle) —
  // the action stored it without a referential check and the engine never rewrites it.
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  s = setPursue(s, ['ghost', 'beta', 'alpha']);
  const { state, verdict } = runToVerdict(s);

  assert.deepEqual(Object.keys(verdict.perVenture), ['beta', 'alpha'],
    'the dead id is dropped; the live ones keep their ranking');
  assert.deepEqual(statuses(verdict), { beta: 'met', alpha: 'breach' });

  // …and the player is TOLD, rather than the list being silently rewritten.
  assert.deepEqual(reviewSystem(guild(state), SYS).filter((i) => i.kind === 'stale_pursue'),
    [{ kind: 'stale_pursue', good: GOOD, ventureId: 'ghost' }]);
});

test('a committing venture the ranking omits is filled LAST, in establishment order', () => {
  // gamma is ranked; alpha and beta are not named at all, so they are appended in the
  // order they were established — the same stable tie-break Gate 3's FCFS default uses.
  let s = fixture([mine('alpha', 3), mine('beta', 3), mine('gamma', 3)]);
  s = setSend(s, 2);
  s = setPursue(s, ['gamma']);
  const { verdict } = runToVerdict(s);

  assert.equal(verdict.Q, 9);
  assert.equal(verdict.delivered, 8);
  assert.deepEqual(Object.keys(verdict.perVenture), ['gamma', 'alpha', 'beta'],
    'ranked first, then the omitted ones in establishment order');
  assert.deepEqual(statuses(verdict), { gamma: 'met', alpha: 'met', beta: 'breach' });
});

test('no ranking at all is pure establishment order', () => {
  let s = fixture([mine('alpha', 3), mine('beta', 3), mine('gamma', 3)]);
  s = setSend(s, 2);
  const { verdict } = runToVerdict(s);
  assert.deepEqual(Object.keys(verdict.perVenture), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(statuses(verdict), { alpha: 'met', beta: 'met', gamma: 'breach' });
});

test('a stale ranking raises the review flag without disturbing the other flags', () => {
  const s = fixture([mine('alpha', 6), mine('beta', 4)]);
  const clean = reviewSystem(guild(s), SYS);
  assert.deepEqual(clean.filter((i) => i.kind === 'stale_pursue'), [], 'nothing stored, nothing flagged');

  const ranked = setPursue(s, ['alpha', 'beta']);
  assert.deepEqual(reviewSystem(guild(ranked), SYS).filter((i) => i.kind === 'stale_pursue'), [],
    'a ranking naming only live producers is not stale');

  const stale = setPursue(s, ['zeta', 'alpha', 'omega']);
  assert.deepEqual(reviewSystem(guild(stale), SYS).filter((i) => i.kind === 'stale_pursue'), [
    { kind: 'stale_pursue', good: GOOD, ventureId: 'omega' },
    { kind: 'stale_pursue', good: GOOD, ventureId: 'zeta' },
  ], 'both dead ids flagged, sorted (invariant 9)');
});

// --- (7) THE CONTROL, THE SURFACE, AND THE NO-OPS ----------------------------------

test('`pursue` round-trips through the action and clears with null', () => {
  const stored = (s) => ((((guild(s).productionProfile || {})[SYS] || {}).goods || {})[GOOD] || {}).pursue;

  let s = setPursue(fixture([mine('alpha', 6), mine('beta', 4)]), ['beta', 'alpha']);
  assert.deepEqual(stored(s), ['beta', 'alpha']);

  // Merging another field leaves the ranking intact (§15.4's sparse merge)…
  s = setSend(s, 2);
  assert.deepEqual(stored(s), ['beta', 'alpha']);

  // …and null CLEARS it back to the establishment-order default.
  s = setPursue(s, null);
  assert.equal(stored(s), undefined, 'cleared, not emptied — the profile stays sparse');
  const { verdict } = runToVerdict(s);
  assert.deepEqual(Object.keys(verdict.perVenture), ['alpha', 'beta']);
});

test('a malformed `pursue` is REFUSED, and refusing it changes not one byte', () => {
  const s = fixture([mine('alpha', 6), mine('beta', 4)]);
  const before = hashState(s);
  for (const bad of ['alpha', 42, [''], ['alpha', 7], [null], {}]) {
    const out = intake(s, [createSetProductionProfileAction({
      guildId: 'g1', systemId: SYS, goods: { [GOOD]: { pursue: bad } },
    })]);
    assert.equal(out.results[0].accepted, false, `${JSON.stringify(bad)} is refused`);
    assert.match(out.results[0].reason, /pursue/);
    assert.equal(hashState(out.state), before);
  }
});

test('the per-venture outcome reaches the snapshot keyed by ventureId', () => {
  // The console's Syndicate roster is a row per producing venture; this is the shape it
  // reads — `commitment` / `delivered` / `status` per row, beside the good-level window
  // block the thermometer already uses. No reshaping, no client-side arithmetic.
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  while (s.tick < N - 1) s = tick(s);

  const snap = buildSnapshot(s);
  const w = snap.production[0].systems[0].goods[GOOD].window;
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
  assert.deepEqual(w.perVenture, {
    alpha: { commitment: 6, delivered: 6, status: 'met' },
    beta: { commitment: 4, delivered: 2, status: 'breach' },
  });
  assert.equal(w.Q, 10);
  assert.equal(w.status, 'breach', 'the good-level block the thermometer reads is still there');
});

test('the slice CHARGES NOTHING: credits move only by the Slice-3a sale', () => {
  let s = fixture([mine('alpha', 6), mine('beta', 4)]);
  s = setSend(s, 2);
  for (let i = 0; i < N * 2; i += 1) {                 // two whole windows, two boundaries
    const before = guild(s).credits;
    s = tick(s);
    const sale = guild(s).lastSyndicateSale;
    const saleThisTick = sale && sale.tick === s.tick ? sale.credited : 0;
    assert.equal(guild(s).credits - before, saleThisTick,
      `tick ${s.tick}: the ONLY credit movement is the sale — no fee is debited (3b-iii)`);
    assert.deepEqual(checkInvariants(s, s.tick), []);
  }
  assert.equal(guild(s).credits + s.syndicate.ledger, 0, 'invariant 2, exactly');
});

test('determinism: the same fixture run twice is byte-identical', () => {
  const run = () => {
    let s = setPursue(setSend(fixture([mine('alpha', 6), mine('beta', 4)]), 2), ['beta', 'alpha']);
    for (let i = 0; i < N * 2; i += 1) s = tick(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});

test('a ranking is telemetry only — it moves no goods and no credits', () => {
  // The pursue order decides WHICH licence is credited with the pile, never how many
  // units are delivered or what they are paid for. Two identical runs, opposite
  // rankings: the same bytes out, and only the verdicts differ.
  const run = (pursue) => {
    let s = setSend(fixture([mine('alpha', 6), mine('beta', 4)]), 2);
    if (pursue) s = setPursue(s, pursue);
    for (let i = 0; i < N; i += 1) s = tick(s);
    return s;
  };
  const a = run(null);
  const b = run(['beta', 'alpha']);
  assert.equal(win(a).delivered, win(b).delivered, 'the same goods delivered');
  assert.equal(guild(a).credits, guild(b).credits, 'the same credits earned');
  assert.equal(a.syndicate.ledger, b.syndicate.ledger);
});
