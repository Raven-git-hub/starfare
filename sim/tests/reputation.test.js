'use strict';

// reputation.test.js — the reputation engine, SLICE 1 (docs/points-and-reputation.md §6
// step 1). Three things become real and nothing else does: a per-venture
// `venture.reputation`, its sum in `guild.guildReputation`, and a FLAT meet/breach that
// moves them at the window boundary.
//
// WHAT THIS SLICE IS, AND WHAT THESE TESTS THEREFORE DO NOT ASSERT. RP is a running
// integer with no band: there is no gain taper, no 800 knee, no 1500 soft cap, no -500
// closure, no inverse-commitment or terms-scaled magnitude, no GP, no mean line
// (§2.2-2.3, §3 — all the NEXT slices). The magnitudes are `[FIRST-CUT]` placeholders
// GIVEN by the human, so no test here pins a balance claim about them; what the tests
// pin is that the number MOVES, moves by exactly the named constant, moves once, moves
// only on a measured verdict, and never drifts from the guild sum.
//
// THE MECHANISM WORTH TESTING is the shared verdict. RP and the licence fee are moved by
// the SAME `status`, read from the SAME row, in the SAME loop (sim/tick.js), so a venture
// can never be charged as breached and credited as met. Several tests below assert the
// fee and the RP together for exactly that reason — agreement is the property, not a
// coincidence to be checked separately.
//
// The fixtures are deliberately the ones licence-fee-charge.test.js already uses (same
// mine, same short window, same paced/pinned send), because this slice rides that
// slice's verdict and a second set of fixtures would be a second definition of "met".

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
const { REP_MEET_FLAT, REP_BREACH_FLAT, reputationDelta } = require('../licence.js');

const SYS = 'sysA';
const SYS_B = 'sysB';
const GOOD = 'titanium';
const N = 4;                                  // a short window, so a boundary is 4 ticks away

const mine = (id, { systemId = SYS, productionRate = 10 } = {}) => ({
  id, ownerGuildId: 'g1', type: 'mining', systemId, resourceType: GOOD, productionRate,
});

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

// Licence at tick 0, before any window opens, so every window is FULL (`windowFraction`
// 1) and no pro-rate is in play — the same convention licence-fee-charge.test.js uses.
const licenceAll = (s, ids, committedOutputPct = 1) => intake(s, ids.map((id) =>
  createApplyForLicenceAction({ guildId: 'g1', ventureId: id, committedOutputPct, windowDays: 7 }))).state;

// Pin the Syndicate send below the pace, so the pile falls short of Q and the licence
// BREACHES. Without this the paced default converges on Q exactly and everything meets.
const starve = (s, systemId = SYS) => intake(s, [createSetProductionProfileAction({
  guildId: 'g1', systemId, goods: { [GOOD]: { syndicate: { mode: 'absolute', value: 1 } } },
})]).state;

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

// --- 1. the two magnitudes, exactly ----------------------------------------------

test('the flat placeholders are the numbers the build prompt gave, and breach outweighs meet', () => {
  // Pinned here so a silent retune of a `[FIRST-CUT]` number cannot pass unnoticed; the
  // real calibrated magnitudes arrive with the band-shaping slice and will move these
  // deliberately, in a commit that also moves docs/phase-1-tuning.md.
  assert.equal(REP_MEET_FLAT, 20);
  assert.equal(REP_BREACH_FLAT, 30);
  // §2.3's "slow to climb, fast to fall" has to hold even at first cut, or the
  // placeholder teaches the opposite of the model it stands in for.
  assert.ok(REP_BREACH_FLAT > REP_MEET_FLAT, 'RP must fall faster than it climbs');
});

test('reputationDelta is the ONE place the sign convention lives', () => {
  assert.equal(reputationDelta('met'), REP_MEET_FLAT, 'met ADDS');
  assert.equal(reputationDelta('breach'), -REP_BREACH_FLAT, 'breach SUBTRACTS');
  // RP moves only at a boundary. An `accruing` reaching here would mean reputation fired
  // on a tick where nothing was judged, and a silent 0 would be a reputation that simply
  // never moved, with nothing going red (§15.5).
  assert.throws(() => reputationDelta('accruing'), /boundary verdict/);
  assert.throws(() => reputationDelta(undefined), /boundary verdict/);
});

test('a MET licence gains exactly +REP_MEET_FLAT at the boundary', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  assert.equal(s.tick, N);
  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'met',
    'the fixture really did meet — the RP claim below is about a verdict, not a hope');
  assert.equal(rp(s, 'm'), REP_MEET_FLAT);
  assert.equal(guild(s).guildReputation, REP_MEET_FLAT);
  assertSumHolds(s, 'after one met boundary');
});

test('a BREACHED licence loses exactly REP_BREACH_FLAT at the boundary', () => {
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  s = runToBoundary(s);

  assert.equal(guild(s).lastLicenceFee.ventures.m.status, 'breach');
  assert.equal(rp(s, 'm'), -REP_BREACH_FLAT, 'one breach from zero lands BELOW zero');
  assert.equal(guild(s).guildReputation, -REP_BREACH_FLAT);
  assertSumHolds(s, 'after one breached boundary');
});

test('the fee and the reputation are moved by ONE verdict — they can never disagree', () => {
  // The mechanism claim, made mechanical: across four boundaries of a breaching run, the
  // venture's fee row and its RP movement are read back together, tick by tick. If a
  // future refactor recomputed the verdict for either consumer, one of these pairs would
  // come apart.
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  let previous = 0;
  for (let w = 0; w < 4; w += 1) {
    s = runToBoundary(s);
    const { status } = guild(s).lastLicenceFee.ventures.m;
    assert.equal(rp(s, 'm') - previous, reputationDelta(status),
      `window ${w + 1}: the RP delta must be the delta OF the verdict the fee was charged on`);
    previous = rp(s, 'm');
  }
});

// --- 2. it moves ONCE, and only on a boundary ------------------------------------

test('a NON-boundary tick moves no reputation at all', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);

  // Every tick strictly inside the first window: RP has not been minted at all, because
  // there has been no verdict to mint it from.
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(s.tick % N === 0, false, 'this test is only meaningful off a boundary');
    assert.equal(ven(s, 'm').reputation, undefined,
      `tick ${s.tick}: no verdict has been reached, so the key does not exist yet`);
    assert.equal(guild(s).guildReputation, 0);
  }

  // Now cross one, then run the inside of the NEXT window: the total must sit still.
  s = tick(s);
  assert.equal(s.tick, N);
  assert.equal(rp(s, 'm'), REP_MEET_FLAT);
  for (let i = 1; i < N; i += 1) {
    s = tick(s);
    assert.equal(rp(s, 'm'), REP_MEET_FLAT, `tick ${s.tick}: a mid-window tick must move nothing`);
    assert.equal(guild(s).guildReputation, REP_MEET_FLAT);
  }
  assertSumHolds(s, 'mid-window');
});

test('ONCE PER BOUNDARY: four windows of a met licence is exactly four gains', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  for (let w = 1; w <= 4; w += 1) {
    s = runToBoundary(s);
    assert.equal(rp(s, 'm'), w * REP_MEET_FLAT, `after ${w} boundaries`);
    assertSumHolds(s, `boundary ${w}`);
  }
});

test('an UNLICENSED guild is untouched — no key, no total, not one byte', () => {
  // The no-op proof at fixture scale: a producing, delivering, but licence-less run
  // crosses two boundaries and comes out byte-identical to itself run before this slice
  // could have touched it (the pinned goldens in commitment-scaffold.test.js and
  // persist.test.js are the standing repo-wide version of this claim).
  let s = fixture([mine('m')]);
  for (let i = 0; i < 2 * N; i += 1) s = tick(s);

  assert.equal(ven(s, 'm').reputation, undefined, 'no verdict was ever reached, so no key exists');
  assert.equal(guild(s).guildReputation, 0);
  assert.equal(canonicalStringify(s).includes('"reputation"'), false,
    'the string "reputation" appears nowhere in an unlicensed run’s serialized state');
  assertSumHolds(s, 'unlicensed run');
});

// --- 3. several ventures accumulate INDEPENDENTLY, and the sum tracks them --------

test('two ventures on opposite verdicts move independently, and the guild total is their sum', () => {
  // `a` sits in SYS and is starved into breach; `b` sits in SYS_B, whose send is left on
  // the paced default and therefore meets. One guild, one boundary, two different fates.
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B })]);
  s = starve(licenceAll(s, ['a', 'b']), SYS);
  s = runToBoundary(s);

  const verdicts = guild(s).lastLicenceFee.ventures;
  assert.equal(verdicts.a.status, 'breach');
  assert.equal(verdicts.b.status, 'met');
  assert.equal(rp(s, 'a'), -REP_BREACH_FLAT, 'the breacher fell on its own');
  assert.equal(rp(s, 'b'), REP_MEET_FLAT, 'the meeter climbed on its own');
  assert.equal(guild(s).guildReputation, REP_MEET_FLAT - REP_BREACH_FLAT,
    'and the guild total is the SUM of the two, not either one');
  assertSumHolds(s, 'two ventures, opposite verdicts');

  // Three more windows: they diverge, and the sum keeps up at every step.
  for (let w = 2; w <= 4; w += 1) {
    s = runToBoundary(s);
    assert.equal(rp(s, 'a'), -w * REP_BREACH_FLAT);
    assert.equal(rp(s, 'b'), w * REP_MEET_FLAT);
    assertSumHolds(s, `window ${w}`);
  }
});

test('a venture licensed LATER starts from zero and does not inherit its sibling’s standing', () => {
  // The independence claim from the other end: `b` joins after `a` has already banked two
  // windows, and its own total starts at the flat gain for ITS first verdict.
  let s = licenceAll(fixture([mine('a'), mine('b', { systemId: SYS_B })]), ['a']);
  s = runToBoundary(s);
  s = runToBoundary(s);
  assert.equal(rp(s, 'a'), 2 * REP_MEET_FLAT);
  assert.equal(ven(s, 'b').reputation, undefined, 'unjudged, so no key');

  s = licenceAll(s, ['b']);
  s = runToBoundary(s);
  assert.equal(rp(s, 'a'), 3 * REP_MEET_FLAT, 'the incumbent kept climbing on its own count');
  assert.ok(Math.abs(rp(s, 'b')) === REP_MEET_FLAT || Math.abs(rp(s, 'b')) === REP_BREACH_FLAT,
    'the newcomer moved by exactly one verdict — its FIRST — whichever way it went');
  assertSumHolds(s, 'a late joiner');
});

// --- 4. integrality, and the negative carve-out -----------------------------------

test('reputation stays an INTEGER through a long mixed run (§15.2)', () => {
  let s = starve(licenceAll(fixture([mine('a'), mine('b', { systemId: SYS_B })]), ['a', 'b']), SYS);
  for (let i = 0; i < 6 * N; i += 1) {
    s = tick(s);
    for (const v of guild(s).ventures) {
      if (v.reputation === undefined) continue;
      assert.ok(Number.isInteger(v.reputation), `venture ${v.id} went fractional at tick ${s.tick}`);
    }
    assert.ok(Number.isInteger(guild(s).guildReputation), `the guild total went fractional at tick ${s.tick}`);
  }
  assertSumHolds(s, 'after six windows');
});

test('a venture driven deep NEGATIVE keeps every invariant green — the exemption works', () => {
  // Five breached windows: -150 at the flat placeholder. Invariant 3's non-negativity
  // carve-out has to cover both the venture field and the guild total, or the tick would
  // halt on a venture doing exactly what breaching is designed to do (§2.2).
  const WINDOWS = 5;
  let s = starve(licenceAll(fixture([mine('m')]), ['m']));
  for (let w = 0; w < WINDOWS; w += 1) s = runToBoundary(s);

  assert.equal(rp(s, 'm'), -WINDOWS * REP_BREACH_FLAT);
  assert.ok(rp(s, 'm') < 0, 'the test is vacuous unless it really went negative');
  assert.equal(guild(s).guildReputation, -WINDOWS * REP_BREACH_FLAT, 'the guild total is negative too');
  assert.deepEqual(checkInvariants(s, s.tick), [], 'all nine invariants green on a deeply negative venture');

  // No floor and no clamp in this slice: -500 (closure) and +1500 (the soft cap) are the
  // NEXT slice's band, so nothing here stops the number at any value.
  assert.ok(rp(s, 'm') > -500, 'this run has not reached the (unbuilt) closure floor, so nothing was clamped');
});

// --- 5. the tripwires fail LOUD (broken on purpose) -------------------------------

test('TRIPWIRE: a guild total that drifts from its ventures is caught', () => {
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);
  assert.deepEqual(checkInvariants(s, s.tick), [], 'green before it is broken');

  // The exact failure the denormalisation risks: a future writer that moves the venture
  // and forgets the guild (or the reverse). Silent without this check — and the fuel
  // layer's mean line would later read the lie (§3).
  const drifted = structuredClone(s);
  drifted.guilds[0].guildReputation += 1;
  const v = checkInvariants(drifted, drifted.tick);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'guild-reputation-is-the-venture-sum (points-and-reputation.md §2)');
  assert.deepEqual(v[0].detail, { stored: REP_MEET_FLAT + 1, sumOfVentures: REP_MEET_FLAT });
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
  // The mirror of the two above: prove the exemption by showing a value that WOULD trip
  // non-negativity on any other field passes here, while the same state's `fuelHoard`
  // still does not get away with it.
  let s = licenceAll(fixture([mine('m')]), ['m']);
  s = runToBoundary(s);

  const negative = structuredClone(s);
  negative.guilds[0].ventures[0].reputation = -400;
  negative.guilds[0].guildReputation = -400;
  assert.deepEqual(checkInvariants(negative, negative.tick), [], 'negative RP is legal');

  const alsoNegativeHoard = structuredClone(negative);
  alsoNegativeHoard.guilds[0].fuelHoard = -1;
  const rules = checkInvariants(alsoNegativeHoard, alsoNegativeHoard.tick).map((x) => x.rule);
  assert.ok(rules.includes('non-negativity (invariant 3)'),
    'a field WITHOUT the carve-out still fails, so the exemption is targeted');
});

// --- 6. serialization: positive, negative, and omitted-when-0 ---------------------

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
  assert.equal(ven(s, 'plus').reputation, 340, 'a positive seed is carried through');
  assert.equal(ven(s, 'minus').reputation, -260, 'and so is a negative one — the sign is not lost');
});

test('serialize -> persist -> load round-trips positive, negative and omitted-when-0', (t) => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'starfare-reputation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A real run, so the values under test were MOVED by the engine rather than typed in:
  // `a` breaches its way negative, `b` meets its way positive, `c` is never licensed and
  // stays keyless.
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B }), mine('c', { systemId: 'sysC' })]);
  s = starve(licenceAll(s, ['a', 'b']), SYS);
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
    let s = fixture([mine('a'), mine('b', { systemId: SYS_B })]);
    s = starve(licenceAll(s, ['a', 'b']), SYS);
    for (let w = 0; w < 3; w += 1) s = runToBoundary(s);
    return hashState(s);
  };
  assert.equal(run(), run());
});

// --- 7. the snapshot surface ------------------------------------------------------

test('the snapshot reports both numbers, ECHOED not re-summed, and needs no schema bump', () => {
  let s = fixture([mine('a'), mine('b', { systemId: SYS_B })]);
  s = starve(licenceAll(s, ['a', 'b']), SYS);
  s = runToBoundary(s);

  const snap = buildSnapshot(s);
  assert.equal(snap.schemaVersion, 7, 'additive — no schema bump');
  assert.equal(SNAPSHOT_SCHEMA, 7);

  const g = snap.guilds.find((x) => x.id === 'g1');
  assert.equal(g.guildReputation, guild(s).guildReputation, 'the guild total is the STORED number');
  const a = snap.ventures.find((x) => x.id === 'a');
  const b = snap.ventures.find((x) => x.id === 'b');
  assert.equal(a.reputation, -REP_BREACH_FLAT, 'a negative reaches the client as a negative');
  assert.equal(b.reputation, REP_MEET_FLAT);
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
